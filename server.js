import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { parse } from 'url';

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const API_BASE_URL = process.env.API_BASE_URL || 'https://zenix.group';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17';

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

if (!OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY is required');
  process.exit(1);
}

// v21: Check ElevenLabs availability at startup
let elevenLabsAvailable = false;
async function checkElevenLabs() {
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
    console.log('⚠️ ElevenLabs not configured, using OpenAI native audio');
    return false;
  }
  try {
    const resp = await fetch('https://api.elevenlabs.io/v1/user', {
      headers: { 'xi-api-key': ELEVENLABS_API_KEY },
    });
    if (resp.ok) {
      const userData = await resp.json();
      console.log(`✅ ElevenLabs API key valid. Subscription: ${userData.subscription?.tier || 'unknown'}`);
      return true;
    } else {
      console.error(`❌ ElevenLabs API key invalid (${resp.status}). Falling back to OpenAI native audio.`);
      return false;
    }
  } catch (e) {
    console.error(`❌ ElevenLabs check failed: ${e.message}. Falling back to OpenAI native audio.`);
    return false;
  }
}

console.log('🚀 Realtime WebSocket Server v21 starting...');
console.log('📍 Port:', PORT);
console.log('🌐 API Base URL:', API_BASE_URL);

const activeSessions = new Map();

// ============================================================
// INTEREST DETECTION KEYWORDS
// ============================================================
const POSITIVE_INTEREST_KEYWORDS = [
  'agendar', 'marcar reunião', 'marcar uma reunião', 'agende', 'marque',
  'vamos marcar', 'vamos agendar',
  'tenho interesse', 'me interessa',
  'quero saber mais', 'saber mais', 'mais informações', 'mais informacoes',
  'me conte mais', 'como funciona',
  'quero conhecer', 'quero entender',
  'quero contratar', 'quero comprar', 'quanto custa',
  'qual o valor', 'qual o preço', 'qual o preco',
  'proposta', 'orçamento', 'orcamento',
  'meu email', 'meu telefone', 'meu whatsapp',
  'manda no whatsapp', 'envia por email',
  'pode ligar de volta', 'me liga depois',
  'fechado', 'vamos lá', 'vamos la', 'bora',
  'quero sim', 'com certeza quero',
];

const NEGATIVE_KEYWORDS = [
  'não tenho interesse', 'nao tenho interesse',
  'não quero', 'nao quero',
  'não preciso', 'nao preciso',
  'não obrigado', 'nao obrigado',
  'desculpa', 'sem interesse',
  'tô ocupado', 'to ocupado',
  'agora não', 'agora nao',
  'outro momento', 'não é o momento',
  'não me interessa', 'nao me interessa',
];

function detectInterest(text) {
  const lowerText = text.toLowerCase().trim();
  if (lowerText.split(/\s+/).length < 3) return { interested: false, signal: null };
  for (const neg of NEGATIVE_KEYWORDS) {
    if (lowerText.includes(neg)) return { interested: false, signal: null };
  }
  for (const keyword of POSITIVE_INTEREST_KEYWORDS) {
    if (lowerText.includes(keyword)) {
      return { interested: true, signal: keyword };
    }
  }
  return { interested: false, signal: null };
}

// ============================================================
// SEND TRANSCRIPTION TO ZENIX BACKEND
// ============================================================
async function sendTranscriptionToBackend(callSid, transcription, scriptId) {
  try {
    const formattedTranscription = transcription.map(t => 
      `[${t.role === 'assistant' ? 'ZENIX' : 'CLIENTE'}] ${t.text}`
    ).join('\n');
    
    const response = await fetch(`${API_BASE_URL}/api/twilio/save-transcription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callSid,
        scriptId,
        transcription: formattedTranscription,
      }),
    });
    
    if (response.ok) {
      console.log(`[Transcription] ✅ Saved to backend for call ${callSid}`);
    } else {
      console.error(`[Transcription] ❌ Backend returned ${response.status}`);
    }
  } catch (error) {
    console.error(`[Transcription] ❌ Error sending to backend:`, error.message);
  }
}

// ============================================================
// SEND INTEREST NOTIFICATION TO ZENIX BACKEND
// ============================================================
async function sendInterestNotification(callSid, contactPhone, signal, transcription, scriptId) {
  try {
    const formattedTranscription = transcription.map(t => 
      `[${t.role === 'assistant' ? 'ZENIX' : 'CLIENTE'}] ${t.text}`
    ).join('\n');
    
    const response = await fetch(`${API_BASE_URL}/api/twilio/client-interest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callSid,
        contactPhone,
        interestSignal: signal,
        transcription: formattedTranscription,
        scriptId,
        detectedAt: new Date().toISOString(),
      }),
    });
    
    if (response.ok) {
      console.log(`[Interest] ✅ Notification sent for call ${callSid} (signal: "${signal}")`);
    } else {
      console.error(`[Interest] ❌ Backend returned ${response.status}`);
    }
  } catch (error) {
    console.error(`[Interest] ❌ Error sending notification:`, error.message);
  }
}

// ============================================================
// FETCH SCRIPT FROM ZENIX BACKEND
// ============================================================
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

// ============================================================
// ELEVENLABS TEXT-TO-SPEECH (with fallback detection)
// ============================================================
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
          voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true },
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[ElevenLabs] ❌ Error ${response.status}: ${errorText}`);
      // v21: Mark ElevenLabs as unavailable for future calls
      elevenLabsAvailable = false;
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
    elevenLabsAvailable = false;
    return false;
  }
}

// ============================================================
// CONNECT TO OPENAI REALTIME API
// ============================================================
function connectToOpenAI(twilioWs, streamSid, callSid, scriptId, sessionData) {
  return new Promise(async (resolve, reject) => {
    console.log(`[OpenAI] Connecting for stream ${streamSid}...`);
    
    let script = null;
    if (scriptId) {
      script = await fetchScript(scriptId);
      if (script) console.log(`[OpenAI] ✅ Script loaded: ${script.name}`);
    }
    
    // v21: Decide voice mode based on ElevenLabs availability
    const useElevenLabs = elevenLabsAvailable;
    console.log(`[v21] Voice mode: ${useElevenLabs ? 'ElevenLabs (text→TTS)' : 'OpenAI Native (direct audio)'}`);
    
    const openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' },
    });

    // v21: ROBUST STATE MACHINE
    const STATE = {
      INIT: 'init',
      SESSION_CONFIGURED: 'session_configured',
      GREETING_REQUESTED: 'greeting_requested',
      GREETING_IN_PROGRESS: 'greeting_in_progress',
      GREETING_COMPLETE: 'greeting_complete',
      VAD_ENABLING: 'vad_enabling',
      CONVERSATION_ACTIVE: 'conversation_active',
    };
    
    let currentState = STATE.INIT;
    let fullResponse = '';
    let isProcessing = false;
    let interestNotified = false;
    let transcriptionSaveTimer = null;
    let userMessageCount = 0;
    let responseCount = 0;
    let greetingResponseId = null;
    // v21: Track if we need to switch from ElevenLabs to OpenAI mid-session
    let sessionUseElevenLabs = useElevenLabs;

    function scheduleTranscriptionSave() {
      if (transcriptionSaveTimer) clearTimeout(transcriptionSaveTimer);
      transcriptionSaveTimer = setTimeout(() => {
        if (sessionData.transcription.length > 0) {
          sendTranscriptionToBackend(callSid, sessionData.transcription, scriptId);
        }
        if (activeSessions.has(streamSid)) {
          scheduleTranscriptionSave();
        }
      }, 15000);
    }

    openaiWs.on('open', () => {
      console.log(`[OpenAI] ✅ Connected`);
      
      const conversationRules = `

=== ESTILO DE COMUNICAÇÃO ===

Você é uma SDR humana, simpática e acolhedora. Sua personalidade é calorosa e genuína.

COMO VOCÊ FALA:
- Fale com ENTUSIASMO e SIMPATIA genuína. Sorria ao falar (isso se reflete na voz).
- Use expressões naturais brasileiras: "que legal!", "olha que bacana", "poxa, entendo", "nossa, que bom!", "com certeza!", "maravilha!"
- Comece respostas com EMPATIA antes de ir ao ponto: "Que bom que você perguntou isso!", "Entendo perfeitamente sua preocupação", "Ótima pergunta!"
- Chame a pessoa pelo nome quando souber. Isso cria conexão.
- Faça pequenos comentários de rapport: "Imagino como deve ser corrido o dia a dia, né?", "Sei como é, a gente sempre quer o melhor pra empresa"
- Use tom CONVERSACIONAL, como se estivesse falando com um conhecido. Nada de tom corporativo frio.

RITMO DA CONVERSA:
- Responda de forma COMPLETA mas CONCISA. Não seja telegráfica nem prolixa.
- Use no máximo 3 frases por resposta. Mas faça cada frase contar.
- Após fazer uma pergunta, PARE e espere a resposta. Não faça duas perguntas seguidas.
- Se o cliente responder algo curto ("sim", "não", "tá"), faça um comentário empático antes de continuar.
- Quando o cliente fizer uma pergunta, RESPONDA com interesse genuíno antes de voltar ao script.

O QUE NÃO FAZER:
- NÃO seja robótica ou mecânica. Você é uma PESSOA, não uma máquina.
- NÃO repita informações que já disse.
- NÃO invente dados que não estão no script.
- NÃO fale rápido demais. Mantenha um ritmo agradável.

OBJETIVO: Criar uma conversa tão natural que o cliente nem perceba que está falando com uma IA. Gere CONFIANÇA e SIMPATIA.

=== FIM DO ESTILO ===

`;
      
      const userPrompt = script?.systemPrompt || 'Você é uma assistente prestativa e simpática que fala português brasileiro com naturalidade.';
      const fullInstructions = `${userPrompt}\n\n${conversationRules}`;
      
      // v21: Configure modalities based on voice provider
      // If using ElevenLabs: text only (we convert text→speech via ElevenLabs API)
      // If using OpenAI native: text + audio (OpenAI generates audio directly)
      const modalities = sessionUseElevenLabs ? ['text'] : ['text', 'audio'];
      
      currentState = STATE.INIT;
      console.log(`[v21] 📊 State: ${currentState} → sending session.update (modalities: ${modalities.join(',')})`);
      
      openaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: modalities,
          instructions: fullInstructions,
          voice: 'shimmer',
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          input_audio_transcription: { model: 'whisper-1' },
          turn_detection: null, // DISABLED - will be enabled after greeting
          temperature: 0.75,
          max_response_output_tokens: 200,
        },
      }));
      
      scheduleTranscriptionSave();
      resolve({ openaiWs, useElevenLabs: sessionUseElevenLabs });
    });

    openaiWs.on('message', async (data) => {
      try {
        const response = JSON.parse(data.toString());
        
        // ========== STATE: session.updated ==========
        if (response.type === 'session.updated') {
          if (currentState === STATE.INIT) {
            currentState = STATE.SESSION_CONFIGURED;
            console.log(`[v21] 📊 State: ${currentState} → sending greeting`);
            
            currentState = STATE.GREETING_REQUESTED;
            const greetingModalities = sessionUseElevenLabs ? ['text'] : ['text', 'audio'];
            openaiWs.send(JSON.stringify({ 
              type: 'response.create', 
              response: { modalities: greetingModalities } 
            }));
          } else if (currentState === STATE.VAD_ENABLING) {
            currentState = STATE.CONVERSATION_ACTIVE;
            console.log(`[v21] 📊 State: ${currentState} → conversation active, VAD enabled`);
          } else {
            console.log(`[v21] ⚠️ Ignoring session.updated in state: ${currentState}`);
          }
          return;
        }
        
        // ========== STATE: response.created ==========
        if (response.type === 'response.created') {
          responseCount++;
          const responseId = response.response?.id;
          console.log(`[v21] 📊 Response #${responseCount} created (id: ${responseId}, state: ${currentState})`);
          
          if (currentState === STATE.GREETING_REQUESTED) {
            greetingResponseId = responseId;
            currentState = STATE.GREETING_IN_PROGRESS;
            console.log(`[v21] 📊 State: ${currentState} (greeting response id: ${greetingResponseId})`);
          } else if (currentState === STATE.GREETING_IN_PROGRESS || currentState === STATE.GREETING_COMPLETE || currentState === STATE.VAD_ENABLING) {
            console.log(`[v21] 🚫 CANCELLING unexpected response #${responseCount} in state: ${currentState}`);
            openaiWs.send(JSON.stringify({ type: 'response.cancel' }));
            return;
          }
        }
        
        // ========== AUDIO: Forward OpenAI native audio to Twilio ==========
        if (response.type === 'response.audio.delta' && response.delta && !sessionUseElevenLabs) {
          if (twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: response.delta } }));
          }
        }
        
        // ========== TEXT: Accumulate for ElevenLabs ==========
        if (response.type === 'response.text.delta' && response.delta && sessionUseElevenLabs) {
          fullResponse += response.delta;
        }
        
        // ========== TEXT DONE: Send to ElevenLabs ==========
        if (response.type === 'response.text.done' && sessionUseElevenLabs) {
          const textToSpeak = fullResponse.trim();
          fullResponse = '';
          if (textToSpeak && !isProcessing) {
            isProcessing = true;
            console.log(`[v21] 📝 Response text: "${textToSpeak}" (state: ${currentState})`);
            sessionData.transcription.push({ role: 'assistant', text: textToSpeak, timestamp: new Date().toISOString() });
            
            const success = await textToSpeechElevenLabs(textToSpeak, twilioWs, streamSid);
            
            // v21: If ElevenLabs failed, switch to OpenAI native for the REST of this session
            if (!success) {
              console.log(`[v21] ⚠️ ElevenLabs failed! Switching to OpenAI native audio for this session.`);
              sessionUseElevenLabs = false;
              // Reconfigure session to use audio modality
              openaiWs.send(JSON.stringify({
                type: 'session.update',
                session: {
                  modalities: ['text', 'audio'],
                },
              }));
            }
            
            isProcessing = false;
          }
        }

        // ========== AUDIO TRANSCRIPT DONE (OpenAI native mode) ==========
        if (response.type === 'response.audio_transcript.done' && !sessionUseElevenLabs) {
          const assistantText = response.transcript || '';
          if (assistantText.trim()) {
            console.log(`[v21] 🤖 "${assistantText}"`);
            sessionData.transcription.push({ role: 'assistant', text: assistantText, timestamp: new Date().toISOString() });
          }
        }
        
        // ========== RESPONSE DONE ==========
        if (response.type === 'response.done') {
          const responseId = response.response?.id;
          console.log(`[v21] 📊 Response done (id: ${responseId}, state: ${currentState})`);
          
          if (currentState === STATE.GREETING_IN_PROGRESS) {
            currentState = STATE.GREETING_COMPLETE;
            console.log(`[v21] 📊 State: ${currentState} → waiting 1.5s before enabling VAD`);
            
            setTimeout(() => {
              if (currentState === STATE.GREETING_COMPLETE) {
                currentState = STATE.VAD_ENABLING;
                console.log(`[v21] 📊 State: ${currentState} → enabling VAD now`);
                openaiWs.send(JSON.stringify({
                  type: 'session.update',
                  session: {
                    turn_detection: { 
                      type: 'server_vad', 
                      threshold: 0.55,
                      prefix_padding_ms: 400,
                      silence_duration_ms: 900
                    },
                  },
                }));
              } else {
                console.log(`[v21] ⚠️ State changed during VAD delay, skipping (state: ${currentState})`);
              }
            }, 1500);
          }
        }
        
        // ========== USER SPEECH STARTED ==========
        if (response.type === 'input_audio_buffer.speech_started') {
          console.log(`[v21] 🎤 User speaking... (state: ${currentState})`);
          if (currentState === STATE.CONVERSATION_ACTIVE) {
            if (twilioWs.readyState === WebSocket.OPEN) {
              twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
            }
          }
        }
        
        // ========== USER TRANSCRIPTION ==========
        if (response.type === 'conversation.item.input_audio_transcription.completed') {
          const userText = response.transcript || '';
          if (userText.trim()) {
            userMessageCount++;
            console.log(`[v21] 💬 User [${userMessageCount}]: "${userText}" (state: ${currentState})`);
            sessionData.transcription.push({ role: 'user', text: userText, timestamp: new Date().toISOString() });
            
            if (!interestNotified && userMessageCount >= 2) {
              const { interested, signal } = detectInterest(userText);
              if (interested) {
                interestNotified = true;
                console.log(`[Interest] 🔔 Positive signal: "${signal}"`);
                sendInterestNotification(callSid, sessionData.contactPhone || 'unknown', signal, sessionData.transcription, scriptId);
              }
            }
          }
        }
        
        if (response.type === 'error') {
          console.error(`[OpenAI] ❌ Error:`, response.error);
          if (currentState === STATE.GREETING_REQUESTED || currentState === STATE.GREETING_IN_PROGRESS) {
            console.log(`[v21] ⚠️ Error during greeting, recovering...`);
            currentState = STATE.GREETING_COMPLETE;
            setTimeout(() => {
              currentState = STATE.VAD_ENABLING;
              openaiWs.send(JSON.stringify({
                type: 'session.update',
                session: {
                  turn_detection: { type: 'server_vad', threshold: 0.55, prefix_padding_ms: 400, silence_duration_ms: 900 },
                },
              }));
            }, 1000);
          }
        }
      } catch (error) {
        console.error(`[OpenAI] Parse error:`, error.message);
      }
    });

    openaiWs.on('error', (error) => { console.error(`[OpenAI] ❌ Error:`, error.message); reject(error); });
    openaiWs.on('close', (code) => {
      console.log(`[OpenAI] Connection closed (code: ${code})`);
      if (transcriptionSaveTimer) clearTimeout(transcriptionSaveTimer);
      if (sessionData.transcription.length > 0) {
        console.log(`[Transcription] 📝 Final save for call ${callSid} (${sessionData.transcription.length} messages)`);
        sendTranscriptionToBackend(callSid, sessionData.transcription, scriptId);
      }
    });
  });
}

// ============================================================
// HANDLE TWILIO WEBSOCKET CONNECTION
// ============================================================
function handleTwilioConnection(ws, req) {
  const { query } = parse(req.url, true);
  const sessionData = { transcription: [], startTime: new Date(), contactPhone: null };
  console.log('[Twilio] 🎤 New connection');
  
  let streamSid = null, openaiWs = null;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());
      if (data.event === 'start') {
        streamSid = data.start.streamSid;
        const callSid = data.start.callSid;
        const scriptId = data.start.customParameters?.scriptId || query.scriptId;
        sessionData.contactPhone = data.start.customParameters?.contactPhone 
          || data.start.customParameters?.to 
          || query.contactPhone 
          || data.start.customParameters?.From
          || null;
        console.log(`[Twilio] 🚀 Stream: ${streamSid}, Call: ${callSid}, Script: ${scriptId}, Phone: ${sessionData.contactPhone}`);
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

// ============================================================
// HTTP SERVER + WEBSOCKET SERVER
// ============================================================
const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      version: '21.0.0',
      voiceProvider: elevenLabsAvailable ? 'ElevenLabs' : 'OpenAI Native',
      voiceId: elevenLabsAvailable ? ELEVENLABS_VOICE_ID : 'shimmer',
      activeSessions: activeSessions.size,
      uptime: Math.round(process.uptime()),
    }));
    return;
  }
  
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Realtime WebSocket Server v21\n');
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  const { pathname } = parse(req.url);
  if (pathname === '/media-stream') handleTwilioConnection(ws, req);
  else ws.close();
});

// v21: Check ElevenLabs at startup, then start server
checkElevenLabs().then((available) => {
  elevenLabsAvailable = available;
  console.log(`🎤 Voice Provider: ${elevenLabsAvailable ? 'ElevenLabs' : 'OpenAI Native'}`);
  console.log(`🎙️ Voice: ${elevenLabsAvailable ? ELEVENLABS_VOICE_ID : 'shimmer (OpenAI)'}`);
  
  server.listen(PORT, () => {
    console.log('========================================');
    console.log(`✅ Server v21 running on port ${PORT}`);
    console.log(`🎤 Voice: ${elevenLabsAvailable ? 'ElevenLabs' : 'OpenAI Native'}`);
    console.log(`🌐 API: ${API_BASE_URL}`);
    console.log('========================================');
  });
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('uncaughtException', (error) => console.error('Uncaught:', error));
process.on('unhandledRejection', (reason) => console.error('Unhandled:', reason));
