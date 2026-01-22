import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { parse } from 'url';

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const API_BASE_URL = process.env.API_BASE_URL || 'https://zenix.group';
const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17';

if (!OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY is required');
  process.exit(1);
}

console.log('🚀 Realtime WebSocket Server v5.1 starting...');
console.log('📍 Port:', PORT);
console.log('🌐 API Base URL:', API_BASE_URL);

const activeSessions = new Map();

async function fetchScript(scriptId) {
  try {
    const response = await fetch(`<LaTex>${API_BASE_URL}/api/scripts/$</LaTex>{scriptId}`);
    if (!response.ok) throw new Error(`HTTP <LaTex>${response.status}`);
    return await response.json();
  } catch (error) {
    console.error(`[Script] Failed to fetch script $</LaTex>{scriptId}:`, error.message);
    return null;
  }
}

async function saveTranscription(callSid, scriptId, transcription) {
  try {
    console.log(`[Transcription] Saving transcription for call <LaTex>${callSid}...`);
    const response = await fetch(`$</LaTex>{API_BASE_URL}/api/twilio/save-transcription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callSid, scriptId, transcription }),
    });
    if (!response.ok) {
      console.error(`[Transcription] Failed to save: HTTP <LaTex>${response.status}`);
    } else {
      console.log(`[Transcription] ✅ Saved successfully for call $</LaTex>{callSid}`);
    }
  } catch (error) {
    console.error(`[Transcription] Error saving:`, error.message);
  }
}

function connectToOpenAI(twilioWs, streamSid, callSid, scriptId, sessionData) {
  return new Promise(async (resolve, reject) => {
    console.log(`[OpenAI] Connecting for stream <LaTex>${streamSid}...`);
    
    let script = null;
    if (scriptId) {
      script = await fetchScript(scriptId);
      if (script) {
        console.log(`[OpenAI] Script loaded: $</LaTex>{script.name}`);
        console.log(`[OpenAI] Voice: <LaTex>${script.voiceId || 'shimmer'}`);
      } else {
        console.warn(`[OpenAI] Script $</LaTex>{scriptId} not found, using defaults`);
      }
    }
    
    const openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
      headers: {
        'Authorization': `Bearer <LaTex>${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    let isInitialGreeting = true;
    let greetingTimeout = null;

    openaiWs.on('open', () => {
      console.log(`[OpenAI] ✅ Connected for stream $</LaTex>{streamSid}`);
      
      const systemInstructions = script?.systemPrompt || 
        'Você é um assistente prestativo que fala português brasileiro de forma natural e amigável.';
      
      const voiceInstructions = script?.voiceInstructions || '';
      
      const conversationRules = `

REGRAS DE CONVERSAÇÃO:
1. Fale de forma natural e fluida
2. Faça pausas naturais entre frases
3. Quando fizer uma pergunta, espere a resposta
4. Seja objetivo mas cordial
5. NÃO repita a saudação inicial`;
      
      const fullInstructions = `<LaTex>${systemInstructions}$</LaTex>{voiceInstructions ? `\n\nInstruções de voz: <LaTex>${voiceInstructions}` : ''}$</LaTex>{conversationRules}`;
      
      const sessionConfig = {
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
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
          max_response_output_tokens: 500,
        },
      };

      openaiWs.send(JSON.stringify(sessionConfig));
      console.log(`[OpenAI] Session configured with script: ${script?.name || 'default'}`);
      
      setTimeout(() => {
        const responseCreate = {
          type: 'response.create',
          response: {
            modalities: ['text', 'audio'],
          },
        };
        openaiWs.send(JSON.stringify(responseCreate));
        console.log(`[OpenAI] Initial greeting requested`);
        
        greetingTimeout = setTimeout(() => {
          isInitialGreeting = false;
          console.log(`[OpenAI] Initial greeting phase ended, barge-in enabled`);
        }, 5000);
      }, 500);
      
      resolve(openaiWs);
    });

    openaiWs.on('message', (data) => {
      try {
        const response = JSON.parse(data.toString());
        
        if (response.type === 'response.audio.delta' && response.delta) {
          const twilioMessage = {
            event: 'media',
            streamSid: streamSid,
            media: { payload: response.delta },
          };
          
          if (twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify(twilioMessage));
          }
        }
        
        if (response.type === 'input_audio_buffer.speech_started') {
          if (isInitialGreeting) {
            console.log(`[OpenAI] 🎤 User speaking during greeting - ignoring`);
          } else {
            console.log(`[OpenAI] 🎤 User started speaking - interrupting AI`);
            openaiWs.send(JSON.stringify({ type: 'response.cancel' }));
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
        
        if (response.type === 'response.audio_transcript.done') {
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
          .map(t => `[<LaTex>${t.role.toUpperCase()}]: $</LaTex>{t.text}`)
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
          console.log(`[Twilio] Stream SID: <LaTex>${streamSid}`);
          console.log(`[Twilio] Call SID: $</LaTex>{actualCallSid}`);
          console.log(`[Twilio] Script ID: ${actualScriptId || 'none'}`);
          
          try {
            openaiWs = await connectToOpenAI(ws, streamSid, actualCallSid, actualScriptId, sessionData);
            
            activeSessions.set(streamSid, {
              twilioWs: ws,
              openaiWs,
              streamSid,
              callSid: actualCallSid,
              scriptId: actualScriptId,
              sessionData,
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
      version: '5.1.0',
      activeSessions: activeSessions.size,
      uptime: process.uptime(),
    }));
    return;
  }
  
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Realtime WebSocket Server v5.1\n');
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
  console.log(`✅ Server running on port <LaTex>${PORT}`);
  console.log(`🌐 WebSocket endpoint: ws://localhost:$</LaTex>{PORT}/media-stream`);
  console.log(`💚 Health check: http://localhost:${PORT}/health`);
  console.log('========================================');
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
