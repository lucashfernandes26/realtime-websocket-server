import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { parse } from 'url';

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const API_BASE_URL = process.env.API_BASE_URL || 'https://zenix.group';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17';

if (!OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY is required');
  process.exit(1);
}

const USE_ELEVENLABS = !!ELEVENLABS_API_KEY && !!ELEVENLABS_VOICE_ID;

console.log('🚀 Realtime WebSocket Server v16 starting...');
console.log('📍 Port:', PORT);
console.log('🌐 API Base URL:', API_BASE_URL);
console.log('🎤 Voice Provider:', USE_ELEVENLABS ? 'ElevenLabs' : 'OpenAI');
console.log('🎙️ Voice ID:', ELEVENLABS_VOICE_ID || 'N/A');

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

async function textToSpeechElevenLabs(text, twilioWs, streamSid) {
  try {
    const startTime = Date.now();
    console.log(`[ElevenLabs] 🎤 Converting: "${text.substring(0, 60)}..."`);
    
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
          voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.0, use_speaker_boost: true },
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[ElevenLabs] ❌ Error ${response.status}: ${errorText}`);
      return false;
    }

    const reader = response.body.getReader();
    let bytesSent = 0;
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const base64Audio = Buffer.from(value).toString('base64');
      bytesSent += value.length;
      if (twilioWs.readyState === WebSocket.OPEN) {
        twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: base64Audio } }));
      }
    }
    
    console.log(`[ElevenLabs] ✅ Sent ${bytesSent} bytes in ${Date.now() - startTime}ms`);
    return true;
  } catch (error) {
    console.error(`[ElevenLabs] ❌ Error:`, error.message);
    return false;
  }
}

function connectToOpenAI(twilioWs, streamSid, callSid, scriptId, sessionData) {
  return new Promise(async (resolve, reject) => {
    console.log(`[OpenAI] Connecting for stream ${streamSid}...`);
    
    let script = null;
    if (scriptId) {
      script = await fetchScript(scriptId);
      if (script) console.log(`[OpenAI] ✅ Script loaded: ${script.name}`);
    }
    
    const useElevenLabs = USE_ELEVENLABS;
    console.log(`[OpenAI] Using ElevenLabs: ${useElevenLabs}`);
    
    const openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' },
    });

    let greetingSent = false;
    let greetingResponseDone = false;
    let fullResponse = '';
    let isProcessing = false;

    openaiWs.on('open', () => {
      console.log(`[OpenAI] ✅ Connected`);
      
      const conversationRules = `

=== REGRAS DE CONVERSAÇÃO TELEFÔNICA ===

Esta é uma LIGAÇÃO TELEFÔNICA real. Siga estas regras:

1. Se apresente com nome, empresa e motivo da ligação
2. Termine a abertura com uma pergunta simples
3. Fale no MÁXIMO 2 frases por vez
4. Após fazer uma pergunta, PARE e ESPERE a resposta
5. NUNCA faça duas perguntas seguidas
6. NUNCA repita a abertura
7. Seja natural e amigável

=== FIM DAS REGRAS ===

`;
      
      const userPrompt = script?.systemPrompt || 'Você é um assistente prestativo que fala português brasileiro.';
      const fullInstructions = `${userPrompt}${conversationRules}`;
      
      // v16 FIX: Start with turn_detection DISABLED (null) to prevent VAD from auto-generating responses
      // We will enable VAD after the greeting is complete
      openaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: useElevenLabs ? ['text'] : ['text', 'audio'],
          instructions: fullInstructions,
          voice: 'shimmer',
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          input_audio_transcription: { model: 'whisper-1' },
          turn_detection: null, // v16: DISABLED initially to prevent auto-response
          temperature: 0.7,
          max_response_output_tokens: 150,
        },
      }));
      
      resolve({ openaiWs, useElevenLabs });
    });

    openaiWs.on('message', async (data) => {
      try {
        const response = JSON.parse(data.toString());
        
        // v16: Send greeting ONLY once when session is confirmed, with VAD disabled
        if (response.type === 'session.updated' && !greetingSent) {
          greetingSent = true;
          console.log(`[OpenAI] 🎬 v16: Sending SINGLE greeting (VAD disabled, no auto-response possible)`);
          openaiWs.send(JSON.stringify({ 
            type: 'response.create', 
            response: { modalities: useElevenLabs ? ['text'] : ['text', 'audio'] } 
          }));
        }
        
        // v16: After greeting response is DONE, re-enable VAD for normal conversation
        if (response.type === 'response.done' && !greetingResponseDone) {
          greetingResponseDone = true;
          console.log(`[OpenAI] 🔄 v16: Greeting complete, enabling VAD for conversation`);
          openaiWs.send(JSON.stringify({
            type: 'session.update',
            session: {
              turn_detection: { 
                type: 'server_vad', 
                threshold: 0.5, 
                prefix_padding_ms: 300, 
                silence_duration_ms: 700 
              },
            },
          }));
        }
        
        // v16: Ignore the second session.updated (when VAD is re-enabled) - don't send another greeting
        if (response.type === 'session.updated' && greetingSent) {
          console.log(`[OpenAI] ℹ️ v16: session.updated received again (VAD re-enabled), ignoring`);
        }
        
        if (response.type === 'response.audio.delta' && response.delta && !useElevenLabs) {
          if (twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: response.delta } }));
          }
        }
        
        if (response.type === 'response.text.delta' && response.delta && useElevenLabs) {
          fullResponse += response.delta;
        }
        
        if (response.type === 'response.text.done' && useElevenLabs) {
          const textToSpeak = fullResponse.trim();
          fullResponse = '';
          if (textToSpeak && !isProcessing) {
            isProcessing = true;
            console.log(`[OpenAI] 📝 Full response: "${textToSpeak}"`);
            sessionData.transcription.push({ role: 'assistant', text: textToSpeak, timestamp: new Date().toISOString() });
            await textToSpeechElevenLabs(textToSpeak, twilioWs, streamSid);
            isProcessing = false;
          }
        }
        
        if (response.type === 'input_audio_buffer.speech_started') {
          console.log(`[User] 🎤 Speaking...`);
          if (twilioWs.readyState === WebSocket.OPEN) twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
        }
        
        if (response.type === 'conversation.item.input_audio_transcription.completed') {
          const userText = response.transcript || '';
          if (userText.trim()) {
            console.log(`[User] 💬 "${userText}"`);
            sessionData.transcription.push({ role: 'user', text: userText, timestamp: new Date().toISOString() });
          }
        }
        
        if (response.type === 'error') console.error(`[OpenAI] ❌ Error:`, response.error);
      } catch (error) {
        console.error(`[OpenAI] Parse error:`, error.message);
      }
    });

    openaiWs.on('error', (error) => { console.error(`[OpenAI] ❌ Error:`, error.message); reject(error); });
    openaiWs.on('close', (code) => console.log(`[OpenAI] Connection closed (code: ${code})`));
  });
}

function handleTwilioConnection(ws, req) {
  const { query } = parse(req.url, true);
  const sessionData = { transcription: [], startTime: new Date() };
  console.log('[Twilio] 🎤 New connection');
  
  let streamSid = null, openaiWs = null;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());
      if (data.event === 'start') {
        streamSid = data.start.streamSid;
        const callSid = data.start.callSid;
        const scriptId = data.start.customParameters?.scriptId || query.scriptId;
        console.log(`[Twilio] 🚀 Stream: ${streamSid}, Script: ${scriptId}`);
        const result = await connectToOpenAI(ws, streamSid, callSid, scriptId, sessionData);
        openaiWs = result.openaiWs;
        activeSessions.set(streamSid, { twilioWs: ws, openaiWs, streamSid, startTime: new Date() });
      }
      if (data.event === 'media' && openaiWs?.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: data.media.payload }));
      }
      if (data.event === 'stop') {
        console.log(`[Twilio] 🛑 Stream stopped`);
        if (openaiWs) openaiWs.close();
        if (streamSid) activeSessions.delete(streamSid);
      }
    } catch (error) { console.error('[Twilio] Error:', error.message); }
  });

  ws.on('close', () => { console.log(`[Twilio] 👋 Disconnected`); if (openaiWs) openaiWs.close(); if (streamSid) activeSessions.delete(streamSid); });
}

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      version: '16.0.0',
      voiceProvider: USE_ELEVENLABS ? 'ElevenLabs' : 'OpenAI',
      voiceId: ELEVENLABS_VOICE_ID || 'N/A',
      activeSessions: activeSessions.size,
      uptime: Math.round(process.uptime()),
    }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Realtime WebSocket Server v16\n');
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  const { pathname } = parse(req.url);
  if (pathname === '/media-stream') handleTwilioConnection(ws, req);
  else ws.close();
});

server.listen(PORT, () => {
  console.log('========================================');
  console.log(`✅ Server v16 running on port ${PORT}`);
  console.log(`🎤 Voice: ${USE_ELEVENLABS ? 'ElevenLabs' : 'OpenAI'}`);
  console.log(`🎙️ Voice ID: ${ELEVENLABS_VOICE_ID || 'N/A'}`);
  console.log('========================================');
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('uncaughtException', (error) => console.error('Uncaught:', error));
process.on('unhandledRejection', (reason) => console.error('Unhandled:', reason));
