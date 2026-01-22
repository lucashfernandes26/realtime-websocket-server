import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { parse } from 'url';

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const API_BASE_URL = process.env.API_BASE_URL || 'https://zenix.group';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17';

if (!OPENAI_API_KEY ) {
  console.error('❌ OPENAI_API_KEY is required');
  process.exit(1);
}

const USE_ELEVENLABS = !!ELEVENLABS_API_KEY && !!ELEVENLABS_VOICE_ID;

console.log('🚀 Realtime WebSocket Server v7 starting...');
console.log('📍 Port:', PORT);
console.log('🌐 API Base URL:', API_BASE_URL);
console.log('🎤 Voice Provider:', USE_ELEVENLABS ? 'ElevenLabs (optimized streaming)' : 'OpenAI');
if (USE_ELEVENLABS) {
  console.log('🎙️ ElevenLabs Voice ID:', ELEVENLABS_VOICE_ID);
}

const activeSessions = new Map();

async function fetchScript(scriptId) {
  try {
    const response = await fetch(`${API_BASE_URL}/api/scripts/${scriptId}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error(`[Script] Failed to fetch script ${scriptId}:`, error.message);
    return null;
  }
}

async function saveTranscription(callSid, scriptId, transcription) {
  try {
    console.log(`[Transcription] Saving transcription for call ${callSid}...`);
    const response = await fetch(`${API_BASE_URL}/api/twilio/save-transcription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callSid, scriptId, transcription }),
    });
    if (!response.ok) {
      console.error(`[Transcription] Failed to save: HTTP ${response.status}`);
    } else {
      console.log(`[Transcription] ✅ Saved successfully for call ${callSid}`);
    }
  } catch (error) {
    console.error(`[Transcription] Error saving:`, error.message);
  }
}

// ElevenLabs Text-to-Speech with streaming - OPTIMIZED for low latency
async function textToSpeechElevenLabs(text, twilioWs, streamSid) {
  try {
    const startTime = Date.now();
    console.log(`[ElevenLabs] Converting: "${text.substring(0, 50)}..."`);
    
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?output_format=ulaw_8000&optimize_streaming_latency=4`,
      {
        method: 'POST',
        headers: {
          'Accept': 'audio/basic',
          'Content-Type': 'application/json',
          'xi-api-key': ELEVENLABS_API_KEY,
        },
        body: JSON.stringify({
          text: text,
          model_id: 'eleven_turbo_v2_5',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.0,
            use_speaker_boost: true,
          },
        } ),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[ElevenLabs] Error: ${response.status} - ${errorText}`);
      return;
    }

    const reader = response.body.getReader();
    let firstChunkTime = null;
    let totalBytes = 0;
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      if (!firstChunkTime) {
        firstChunkTime = Date.now();
        console.log(`[ElevenLabs] ⚡ First chunk in ${firstChunkTime - startTime}ms`);
      }
      
      totalBytes += value.length;
      const base64Audio = Buffer.from(value).toString('base64');
      
      if (twilioWs.readyState === WebSocket.OPEN) {
        twilioWs.send(JSON.stringify({
          event: 'media',
          streamSid: streamSid,
          media: { payload: base64Audio },
        }));
      }
    }
    
    const totalTime = Date.now() - startTime;
    console.log(`[ElevenLabs] ✅ Done: ${totalBytes} bytes in ${totalTime}ms`);
  } catch (error) {
    console.error(`[ElevenLabs] Error:`, error.message);
  }
}

function connectToOpenAI(twilioWs, streamSid, callSid, scriptId, sessionData) {
  return new Promise(async (resolve, reject) => {
    console.log(`[OpenAI] Connecting for stream ${streamSid}...`);
    
    let script = null;
    if (scriptId) {
      script = await fetchScript(scriptId);
      if (script) {
        console.log(`[OpenAI] Script loaded: ${script.name}`);
      } else {
        console.warn(`[OpenAI] Script ${scriptId} not found, using defaults`);
      }
    }
    
    const useElevenLabs = USE_ELEVENLABS && (script?.useElevenLabs !== false);
    console.log(`[Voice] Using ${useElevenLabs ? 'ElevenLabs (optimized)' : 'OpenAI'} for TTS`);
    
    const openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    let isInitialGreeting = true;
    let greetingTimeout = null;
    let pendingTextResponse = '';
    let sentenceBuffer = '';
    let isProcessingSentence = false;
    let sentenceQueue = [];

    async function processSentenceQueue() {
      if (isProcessingSentence || sentenceQueue.length === 0) return;
      
      isProcessingSentence = true;
      const sentence = sentenceQueue.shift();
      
      if (sentence && sentence.trim()) {
        await textToSpeechElevenLabs(sentence, twilioWs, streamSid);
      }
      
      isProcessingSentence = false;
      
      if (sentenceQueue.length > 0) {
        processSentenceQueue();
      }
    }

    function queueSentence(sentence) {
      if (sentence && sentence.trim()) {
        sentenceQueue.push(sentence);
        processSentenceQueue();
      }
    }

    openaiWs.on('open', () => {
      console.log(`[OpenAI] ✅ Connected for stream ${streamSid}`);
      
      const systemInstructions = script?.systemPrompt || 
        'Você é um assistente prestativo que fala português brasileiro de forma natural e amigável.';
      
      const voiceInstructions = script?.voiceInstructions || '';
      
      const conversationRules = `

REGRAS DE CONVERSAÇÃO:
1. Fale de forma natural e fluida
2. Use frases curtas e diretas para respostas mais rápidas
3. Quando fizer uma pergunta, espere a resposta
4. Seja objetivo mas cordial
5. NÃO repita a saudação inicial`;
      
      const fullInstructions = `${systemInstructions}${voiceInstructions ? `\n\nInstruções de voz: ${voiceInstructions}` : ''}${conversationRules}`;
      
      const sessionConfig = {
        type: 'session.update',
        session: {
          modalities: useElevenLabs ? ['text'] : ['text', 'audio'],
          instructions: fullInstructions,
          voice: script?.voiceId || 'shimmer',
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          input_audio_transcription: {
            model: 'whisper-1',
          },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 700,
          },
          temperature: 0.7,
          max_response_output_tokens: 300,
        },
      };

      openaiWs.send(JSON.stringify(sessionConfig));
      console.log(`[OpenAI] Session configured (ElevenLabs: ${useElevenLabs})`);
      
      setTimeout(() => {
        const responseCreate = {
          type: 'response.create',
          response: {
            modalities: useElevenLabs ? ['text'] : ['text', 'audio'],
          },
        };
        openaiWs.send(JSON.stringify(responseCreate));
        console.log(`[OpenAI] Initial greeting requested`);
        
        greetingTimeout = setTimeout(() => {
          isInitialGreeting = false;
          console.log(`[OpenAI] Initial greeting phase ended, barge-in enabled`);
        }, 5000);
      }, 500);
      
      resolve({ openaiWs, useElevenLabs });
    });

    openaiWs.on('message', async (data) => {
      try {
        const response = JSON.parse(data.toString());
        
        if (response.type === 'response.audio.delta' && response.delta && !useElevenLabs) {
          const twilioMessage = {
            event: 'media',
            streamSid: streamSid,
            media: { payload: response.delta },
          };
          
          if (twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify(twilioMessage));
          }
        }
        
        if (response.type === 'response.text.delta' && response.delta && useElevenLabs) {
          sentenceBuffer += response.delta;
          pendingTextResponse += response.delta;
          
          const sentenceEnders = /[.!?]/;
          while (sentenceEnders.test(sentenceBuffer)) {
            const match = sentenceBuffer.match(/^([^.!?]+[.!?]+)/);
            if (match) {
              const completeSentence = match[1].trim();
              sentenceBuffer = sentenceBuffer.slice(match[0].length).trim();
              
              if (completeSentence.length > 0) {
                console.log(`[Streaming] Queueing sentence: "${completeSentence}"`);
                queueSentence(completeSentence);
              }
            } else {
              break;
            }
          }
        }
        
        if (response.type === 'response.text.done' && useElevenLabs) {
          if (sentenceBuffer.trim()) {
            console.log(`[Streaming] Queueing final: "${sentenceBuffer.trim()}"`);
            queueSentence(sentenceBuffer.trim());
          }
          sentenceBuffer = '';
          
          if (pendingTextResponse.trim()) {
            sessionData.transcription.push({
              role: 'assistant',
              text: pendingTextResponse,
              timestamp: new Date().toISOString(),
            });
          }
          
          pendingTextResponse = '';
        }
        
        if (response.type === 'input_audio_buffer.speech_started') {
          if (isInitialGreeting) {
            console.log(`[OpenAI] 🎤 User speaking during greeting - ignoring`);
          } else {
            console.log(`[OpenAI] 🎤 User started speaking - interrupting AI`);
            openaiWs.send(JSON.stringify({ type: 'response.cancel' }));
            
            pendingTextResponse = '';
            sentenceBuffer = '';
            sentenceQueue = [];
            
            if (twilioWs.readyState === WebSocket.OPEN) {
              twilioWs.send(JSON.stringify({
                event: 'clear',
                streamSid: streamSid,
              }));
            }
          }
        }
        
        if (response.type === 'response.done') {
          isInitialGreeting = false;
          if (greetingTimeout) {
            clearTimeout(greetingTimeout);
            greetingTimeout = null;
          }
          console.log(`[OpenAI] Response completed, barge-in enabled`);
        }
        
        if (response.type === 'conversation.item.input_audio_transcription.completed') {
          const userText = response.transcript || '';
          if (userText.trim()) {
            sessionData.transcription.push({
              role: 'user',
              text: userText,
              timestamp: new Date().toISOString(),
            });
            console.log(`[Transcription] User: ${userText}`);
          }
        }
        
        if (response.type === 'response.audio_transcript.done' && !useElevenLabs) {
          const aiText = response.transcript || '';
          if (aiText.trim()) {
            sessionData.transcription.push({
              role: 'assistant',
              text: aiText,
              timestamp: new Date().toISOString(),
            });
            console.log(`[Transcription] AI: ${aiText}`);
          }
        }
        
        if (response.type === 'error') {
          console.error(`[OpenAI] Error:`, response.error);
        }
      } catch (error) {
        console.error(`[OpenAI] Error parsing message:`, error.message);
      }
    });

    openaiWs.on('error', (error) => {
      console.error(`[OpenAI] WebSocket error:`, error.message);
      reject(error);
    });

    openaiWs.on('close', async () => {
      console.log(`[OpenAI] Connection closed for stream ${streamSid}`);
      
      if (greetingTimeout) {
        clearTimeout(greetingTimeout);
      }
      
      if (sessionData.transcription.length > 0 && callSid) {
        const transcriptionText = sessionData.transcription
          .map(t => `[${t.role.toUpperCase()}]: ${t.text}`)
          .join('\n');
        await saveTranscription(callSid, scriptId, transcriptionText);
      }
    });
  });
}

function handleTwilioConnection(ws, req) {
  const { query } = parse(req.url, true);
  const callSid = query.callSid;
  const scriptId = query.scriptId;
  
  const sessionData = {
    transcription: [],
    startTime: new Date(),
  };
  
  console.log('========================================');
  console.log('[Twilio] 🎤 New connection');
  console.log('[Twilio] Call SID:', callSid || 'N/A');
  console.log('[Twilio] Script ID:', scriptId || 'N/A');
  console.log('========================================');
  
  let streamSid = null;
  let openaiWs = null;
  let useElevenLabs = false;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());

      switch (data.event) {
        case 'connected':
          console.log('[Twilio] 📞 Connected event received');
          break;

        case 'start':
          streamSid = data.start.streamSid;
          const actualCallSid = data.start.callSid;
          const actualScriptId = data.start.customParameters?.scriptId || scriptId;
          
          console.log(`[Twilio] 🚀 Stream started`);
          console.log(`[Twilio] Stream SID: ${streamSid}`);
          console.log(`[Twilio] Call SID: ${actualCallSid}`);
          console.log(`[Twilio] Script ID: ${actualScriptId || 'none'}`);
          
          try {
            const result = await connectToOpenAI(ws, streamSid, actualCallSid, actualScriptId, sessionData);
            openaiWs = result.openaiWs;
            useElevenLabs = result.useElevenLabs;
            
            activeSessions.set(streamSid, {
              twilioWs: ws,
              openaiWs,
              streamSid,
              callSid: actualCallSid,
              scriptId: actualScriptId,
              sessionData,
              useElevenLabs,
            });
          } catch (error) {
            console.error('[Twilio] ❌ Failed to connect to OpenAI:', error.message);
          }
          break;

        case 'media':
          if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            const audioPayload = data.media.payload;
            
            openaiWs.send(JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: audioPayload,
            }));
          }
          break;

        case 'stop':
          console.log('[Twilio] 🛑 Stream stopped');
          if (openaiWs) openaiWs.close();
          if (streamSid) activeSessions.delete(streamSid);
          break;
      }
    } catch (error) {
      console.error('[Twilio] Error handling message:', error.message);
    }
  });

  ws.on('close', () => {
    console.log('[Twilio] 🔌 Connection closed');
    if (openaiWs) openaiWs.close();
    if (streamSid) activeSessions.delete(streamSid);
  });

  ws.on('error', (error) => {
    console.error('[Twilio] WebSocket error:', error.message);
  });
}

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      version: '7.0.0',
      voiceProvider: USE_ELEVENLABS ? 'ElevenLabs (optimized streaming)' : 'OpenAI',
      activeSessions: activeSessions.size,
      uptime: process.uptime(),
    }));
    return;
  }
  
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Realtime WebSocket Server v7 (ElevenLabs Optimized Streaming)\n');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const { pathname } = parse(req.url);
  
  if (pathname === '/media-stream') {
    handleTwilioConnection(ws, req);
  } else {
    console.log(`[Server] ❌ Unknown path: ${pathname}`);
    ws.close();
  }
});

server.listen(PORT, () => {
  console.log('========================================');
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🎤 Voice: ${USE_ELEVENLABS ? 'ElevenLabs (optimized)' : 'OpenAI'}`);
  console.log(`🌐 WebSocket endpoint: ws://localhost:${PORT}/media-stream`);
  console.log(`💚 Health check: http://localhost:${PORT}/health` );
  console.log('========================================');
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
