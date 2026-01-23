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

console.log('🚀 Realtime WebSocket Server v12 starting...');
console.log('📍 Port:', PORT);
console.log('🌐 API Base URL:', API_BASE_URL);
console.log('🎤 Voice Provider:', USE_ELEVENLABS ? 'ElevenLabs' : 'OpenAI');

const activeSessions = new Map();

async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      if (response.status >= 500) {
        await new Promise(r => setTimeout(r, Math.pow(2, i) * 1000));
        continue;
      }
      return response;
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise(r => setTimeout(r, Math.pow(2, i) * 1000));
    }
  }
}

async function fetchScript(scriptId) {
  try {
    const response = await fetchWithRetry(`${API_BASE_URL}/api/scripts/${scriptId}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error(`[Script] Failed to fetch script ${scriptId}:`, error.message);
    return null;
  }
}

async function saveTranscription(callSid, scriptId, transcription) {
  try {
    const response = await fetchWithRetry(`${API_BASE_URL}/api/twilio/save-transcription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callSid, scriptId, transcription }),
    });
    if (response.ok) {
      console.log(`[Transcription] ✅ Saved for call ${callSid}`);
    }
  } catch (error) {
    console.error(`[Transcription] Error:`, error.message);
  }
}

async function textToSpeechElevenLabs(text, twilioWs, streamSid, abortSignal) {
  try {
    if (abortSignal?.aborted) return false;
    
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
            similarity_boost: 0.8,
            style: 0.0,
            use_speaker_boost: true,
          },
        } ),
        signal: abortSignal,
      }
    );

    if (!response.ok) {
      console.error(`[ElevenLabs] Error: ${response.status}`);
      return false;
    }

    const reader = response.body.getReader();
    let bytesSent = 0;
    
    while (true) {
      if (abortSignal?.aborted) {
        reader.cancel();
        return false;
      }
      
      const { done, value } = await reader.read();
      if (done) break;
      
      const base64Audio = Buffer.from(value).toString('base64');
      bytesSent += value.length;
      
      if (twilioWs.readyState === WebSocket.OPEN) {
        twilioWs.send(JSON.stringify({
          event: 'media',
          streamSid: streamSid,
          media: { payload: base64Audio },
        }));
      }
    }
    
    console.log(`[ElevenLabs] ✅ Done in ${Date.now() - startTime}ms (${bytesSent} bytes)`);
    return true;
  } catch (error) {
    if (error.name === 'AbortError') {
      console.log(`[ElevenLabs] Aborted`);
      return false;
    }
    console.error(`[ElevenLabs] Error:`, error.message);
    return false;
  }
}

function connectToOpenAI(twilioWs, streamSid, callSid, scriptId, sessionData) {
  return new Promise(async (resolve, reject) => {
    console.log(`[OpenAI] Connecting for stream ${streamSid}...`);
    
    let script = null;
    if (scriptId) {
      script = await fetchScript(scriptId);
      if (script) {
        console.log(`[OpenAI] ✅ Script loaded: ${script.name}`);
      }
    }
    
    const useElevenLabs = USE_ELEVENLABS && (script?.useElevenLabs !== false);
    
    const openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    let state = {
      waitingForUser: false,
      userHasSpoken: false,
      isAISpeaking: false,
      turnCount: 0,
      lastUserInput: '',
      conversationActive: true,
      abortController: null,
    };
    
    let pendingTextResponse = '';
    let sentenceBuffer = '';
    let sentenceQueue = [];
    let isProcessingSentence = false;
    
    const pingInterval = setInterval(() => {}, 30000);

    async function processSentenceQueue() {
      if (isProcessingSentence || sentenceQueue.length === 0 || !state.conversationActive) return;
      
      isProcessingSentence = true;
      state.isAISpeaking = true;
      state.abortController = new AbortController();
      
      while (sentenceQueue.length > 0 && state.conversationActive) {
        if (state.abortController.signal.aborted) break;
        
        const sentence = sentenceQueue.shift();
        if (sentence && sentence.trim()) {
          const success = await textToSpeechElevenLabs(sentence, twilioWs, streamSid, state.abortController.signal);
          if (!success) break;
        }
      }
      
      isProcessingSentence = false;
      state.isAISpeaking = false;
      state.abortController = null;
      
      if (state.conversationActive && sentenceQueue.length === 0) {
        console.log(`[State] AI finished - waiting for user (turn ${state.turnCount})`);
        state.waitingForUser = true;
      }
    }

    function queueSentence(sentence) {
      if (sentence && sentence.trim() && state.conversationActive) {
        sentenceQueue.push(sentence);
        processSentenceQueue();
      }
    }
    
    function interruptAI() {
      console.log(`[State] Interrupting AI`);
      if (state.abortController) state.abortController.abort();
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({ type: 'response.cancel' }));
      }
      pendingTextResponse = '';
      sentenceBuffer = '';
      sentenceQueue = [];
      state.isAISpeaking = false;
      isProcessingSentence = false;
      if (twilioWs.readyState === WebSocket.OPEN) {
        twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
      }
    }

    openaiWs.on('open', () => {
      console.log(`[OpenAI] ✅ Connected`);
      
      const conversationRules = `

=== REGRAS DE CONVERSAÇÃO TELEFÔNICA ===

Esta é uma LIGAÇÃO TELEFÔNICA real. Siga estas regras RIGOROSAMENTE:

ABERTURA:
- Se apresente com nome, empresa e motivo da ligação
- Termine com uma pergunta simples como "tudo bem?" ou "posso falar?"
- Exemplo: "Oi! Aqui é a Bruna da Solare, tô ligando sobre energia solar. Tudo bem com você?"

DURANTE A CONVERSA:
- Fale no MÁXIMO 2 frases por vez
- Após fazer uma pergunta, PARE e ESPERE a resposta
- Responda ao que a pessoa disse ANTES de fazer nova pergunta
- Seja natural, amigável e use linguagem informal

REGRAS CRÍTICAS:
- NUNCA faça duas perguntas seguidas
- NUNCA ignore o que a pessoa disse
- NUNCA faça monólogos longos
- Se a pessoa disser só "oi" ou "alô", continue naturalmente
- Se a pessoa parecer confusa, explique novamente de forma simples

OBJETIVO:
Siga o script fornecido para alcançar o objetivo (ex: agendar visita, qualificar lead, etc.)

=== FIM DAS REGRAS ===

`;
      
      const userPrompt = script?.systemPrompt || 'Você é um assistente prestativo que fala português brasileiro de forma natural e amigável.';
      const voiceInstructions = script?.voiceInstructions || '';
      const fullInstructions = `${userPrompt}${voiceInstructions ? `\n\nInstruções de voz: ${voiceInstructions}` : ''}${conversationRules}`;
      
      const sessionConfig = {
        type: 'session.update',
        session: {
          modalities: useElevenLabs ? ['text'] : ['text', 'audio'],
          instructions: fullInstructions,
          voice: script?.voiceId || 'shimmer',
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          input_audio_transcription: { model: 'whisper-1' },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 800,
          },
          temperature: 0.7,
          max_response_output_tokens: 150,
        },
      };

      openaiWs.send(JSON.stringify(sessionConfig));
      
      setTimeout(() => {
        if (openaiWs.readyState === WebSocket.OPEN && state.conversationActive) {
          console.log(`[OpenAI] Starting conversation...`);
          openaiWs.send(JSON.stringify({
            type: 'response.create',
            response: { modalities: useElevenLabs ? ['text'] : ['text', 'audio'] },
          }));
        }
      }, 500);
      
      resolve({ openaiWs, useElevenLabs });
    });

    openaiWs.on('message', async (data) => {
      try {
        const response = JSON.parse(data.toString());
        
        if (response.type === 'response.audio.delta' && response.delta && !useElevenLabs) {
          state.isAISpeaking = true;
          if (twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({
              event: 'media',
              streamSid: streamSid,
              media: { payload: response.delta },
            }));
          }
        }
        
        if (response.type === 'response.text.delta' && response.delta && useElevenLabs) {
          sentenceBuffer += response.delta;
          pendingTextResponse += response.delta;
          
          let match;
          while ((match = sentenceBuffer.match(/^([^.!?]*[.!?])\s*/))) {
            const completeSentence = match[1].trim();
            sentenceBuffer = sentenceBuffer.slice(match[0].length);
            
            if (completeSentence.length > 0) {
              console.log(`[OpenAI] 📝 "${completeSentence}"`);
              queueSentence(completeSentence);
              
              if (completeSentence.includes('?')) {
                console.log(`[OpenAI] ❓ Question - stopping generation`);
                openaiWs.send(JSON.stringify({ type: 'response.cancel' }));
                sentenceBuffer = '';
                break;
              }
            }
          }
        }
        
        if (response.type === 'response.text.done' && useElevenLabs) {
          if (sentenceBuffer.trim()) queueSentence(sentenceBuffer.trim());
          sentenceBuffer = '';
          
          if (pendingTextResponse.trim()) {
            sessionData.transcription.push({
              role: 'assistant',
              text: pendingTextResponse,
              timestamp: new Date().toISOString(),
            });
            console.log(`[AI] ${pendingTextResponse}`);
          }
          pendingTextResponse = '';
          state.turnCount++;
        }
        
        if (response.type === 'input_audio_buffer.speech_started') {
          console.log(`[User] 🎤 Speaking...`);
          state.userHasSpoken = true;
          state.waitingForUser = false;
          if (state.isAISpeaking) interruptAI();
        }
        
        if (response.type === 'input_audio_buffer.speech_stopped') {
          console.log(`[User] 🎤 Stopped`);
        }
        
        if (response.type === 'response.audio.done' && !useElevenLabs) {
          state.isAISpeaking = false;
          state.waitingForUser = true;
          state.turnCount++;
        }
        
        if (response.type === 'response.done') {
          state.isAISpeaking = false;
        }
        
        if (response.type === 'response.created') {
          if (state.waitingForUser && !state.userHasSpoken && state.turnCount > 0) {
            console.log(`[OpenAI] ⛔ Blocking auto-response`);
            openaiWs.send(JSON.stringify({ type: 'response.cancel' }));
          } else {
            state.userHasSpoken = false;
            state.waitingForUser = false;
          }
        }
        
        if (response.type === 'conversation.item.input_audio_transcription.completed') {
          const userText = response.transcript || '';
          if (userText.trim()) {
            state.lastUserInput = userText;
            sessionData.transcription.push({
              role: 'user',
              text: userText,
              timestamp: new Date().toISOString(),
            });
            console.log(`[User] ${userText}`);
            state.userHasSpoken = true;
            state.waitingForUser = false;
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
          }
        }
        
        if (response.type === 'error') {
          console.error(`[OpenAI] ❌ Error:`, response.error);
          if (response.error?.code === 'session_expired') {
            state.conversationActive = false;
          }
        }
      } catch (error) {
        console.error(`[OpenAI] Parse error:`, error.message);
      }
    });

    openaiWs.on('error', (error) => {
      console.error(`[OpenAI] ❌ WebSocket error:`, error.message);
      clearInterval(pingInterval);
      reject(error);
    });

    openaiWs.on('close', async (code) => {
      console.log(`[OpenAI] Connection closed (code: ${code})`);
      clearInterval(pingInterval);
      state.conversationActive = false;
      
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
  const sessionData = { transcription: [], startTime: new Date() };
  
  console.log('[Twilio] 🎤 New connection');
  
  let streamSid = null;
  let openaiWs = null;
  let connectionActive = true;

  ws.on('message', async (message) => {
    if (!connectionActive) return;
    
    try {
      const data = JSON.parse(message.toString());

      if (data.event === 'start') {
        streamSid = data.start.streamSid;
        const callSid = data.start.callSid;
        const scriptId = data.start.customParameters?.scriptId || query.scriptId;
        
        console.log(`[Twilio] 🚀 Stream: ${streamSid}, Script: ${scriptId}`);
        
        const result = await connectToOpenAI(ws, streamSid, callSid, scriptId, sessionData);
        openaiWs = result.openaiWs;
        
        activeSessions.set(streamSid, { twilioWs: ws, openaiWs, streamSid, callSid, scriptId, sessionData, startTime: new Date() });
      }
      
      if (data.event === 'media' && openaiWs?.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: data.media.payload }));
      }
      
      if (data.event === 'stop') {
        connectionActive = false;
        if (openaiWs) openaiWs.close();
        if (streamSid) activeSessions.delete(streamSid);
      }
    } catch (error) {
      console.error('[Twilio] Error:', error.message);
    }
  });

  ws.on('close', () => {
    connectionActive = false;
    if (openaiWs) openaiWs.close();
    if (streamSid) activeSessions.delete(streamSid);
  });
}

const server = createServer((req, res) => {
  if (req.url === '/health') {
    const sessions = Array.from(activeSessions.values()).map(s => ({
      streamSid: s.streamSid,
      duration: Math.round((Date.now() - s.startTime) / 1000),
    }));
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      version: '12.0.0',
      voiceProvider: USE_ELEVENLABS ? 'ElevenLabs' : 'OpenAI',
      features: ['improved-stability', 'abort-controller', 'retry-logic', 'better-turn-tracking'],
      activeSessions: activeSessions.size,
      sessions: sessions,
      uptime: Math.round(process.uptime()),
    }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Realtime WebSocket Server v12\n');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const { pathname } = parse(req.url);
  if (pathname === '/media-stream') handleTwilioConnection(ws, req);
  else ws.close();
});

server.listen(PORT, () => {
  console.log(`✅ Server v12 running on port ${PORT}`);
});

process.on('SIGTERM', () => {
  for (const [, session] of activeSessions) {
    if (session.openaiWs) session.openaiWs.close();
    if (session.twilioWs) session.twilioWs.close();
  }
  server.close(() => process.exit(0));
});

process.on('uncaughtException', (error) => console.error('Uncaught exception:', error));
process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));
