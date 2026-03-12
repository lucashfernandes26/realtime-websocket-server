import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { parse } from 'url';

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const API_BASE_URL = process.env.API_BASE_URL || 'https://zenix.group';

// v22: Use the latest model URL with temperature parameter
const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17';

if (!OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is required');
  process.exit(1);
}

console.log('Realtime WebSocket Server v22 starting...');
console.log('Port:', PORT);
console.log('API Base URL:', API_BASE_URL);

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
      body: JSON.stringify({ callSid, scriptId, transcription: formattedTranscription }),
    });
    
    if (response.ok) {
      console.log(`[Transcription] Saved for call ${callSid}`);
    } else {
      console.error(`[Transcription] Backend returned ${response.status}`);
    }
  } catch (error) {
    console.error(`[Transcription] Error:`, error.message);
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
        callSid, contactPhone, interestSignal: signal,
        transcription: formattedTranscription, scriptId,
        detectedAt: new Date().toISOString(),
      }),
    });
    
    if (response.ok) {
      console.log(`[Interest] Notification sent for call ${callSid} (signal: "${signal}")`);
    } else {
      console.error(`[Interest] Backend returned ${response.status}`);
    }
  } catch (error) {
    console.error(`[Interest] Error:`, error.message);
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
// HANDLE TWILIO WEBSOCKET CONNECTION
// v22: Simplified, based on official Twilio example
// ============================================================
function handleTwilioConnection(ws, req) {
  const { query } = parse(req.url, true);
  const sessionData = { transcription: [], startTime: new Date(), contactPhone: null };
  console.log('[Twilio] New WebSocket connection');
  
  // Connection-specific state
  let streamSid = null;
  let latestMediaTimestamp = 0;
  let lastAssistantItem = null;
  let markQueue = [];
  let responseStartTimestampTwilio = null;
  let interestNotified = false;
  let userMessageCount = 0;
  let transcriptionSaveTimer = null;
  let callSid = null;
  let scriptId = null;
  let scriptData = null;
  let audioChunksSent = 0;
  let audioChunksReceived = 0;

  // v22: Connect to OpenAI immediately (don't wait for start event)
  // This reduces latency by having the OpenAI connection ready
  const openAiWs = new WebSocket(OPENAI_REALTIME_URL, {
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  });

  // v22: Track if session is configured
  let sessionConfigured = false;
  let greetingSent = false;
  let vadEnabled = false;

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

  // Send mark messages to Media Streams
  function sendMark() {
    if (streamSid && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        event: 'mark',
        streamSid: streamSid,
        mark: { name: 'responsePart' },
      }));
      markQueue.push('responsePart');
    }
  }

  // Handle interruption when the caller's speech starts
  function handleSpeechStarted() {
    if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
      const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;

      if (lastAssistantItem) {
        openAiWs.send(JSON.stringify({
          type: 'conversation.item.truncate',
          item_id: lastAssistantItem,
          content_index: 0,
          audio_end_ms: elapsedTime,
        }));
      }

      // Clear Twilio's audio buffer
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event: 'clear', streamSid }));
      }

      // Reset
      markQueue = [];
      lastAssistantItem = null;
      responseStartTimestampTwilio = null;
    }
  }

  // ========== OpenAI WebSocket Events ==========
  openAiWs.on('open', async () => {
    console.log('[OpenAI] Connected');
    
    // v22: If we already have the scriptId (from query params), fetch and configure now
    scriptId = query.scriptId || null;
    if (scriptId) {
      scriptData = await fetchScript(scriptId);
      if (scriptData) console.log(`[OpenAI] Script loaded: ${scriptData.name}`);
    }
    
    // v22: Configure session immediately
    configureSession();
  });

  function configureSession() {
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
    
    const userPrompt = scriptData?.systemPrompt || 'Você é uma assistente prestativa e simpática que fala português brasileiro com naturalidade.';
    const fullInstructions = `${userPrompt}\n\n${conversationRules}`;
    
    console.log('[OpenAI] Sending session.update');
    
    openAiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: fullInstructions,
        voice: 'shimmer',
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: null, // Disabled initially, enabled after greeting
        temperature: 0.75,
        max_response_output_tokens: 200,
      },
    }));
  }

  openAiWs.on('message', (data) => {
    try {
      const response = JSON.parse(data.toString());

      // ========== SESSION UPDATED ==========
      if (response.type === 'session.updated') {
        if (!sessionConfigured) {
          sessionConfigured = true;
          console.log('[OpenAI] Session configured');
          
          // v22: Send greeting immediately
          if (!greetingSent) {
            greetingSent = true;
            console.log('[OpenAI] Requesting greeting response');
            openAiWs.send(JSON.stringify({
              type: 'response.create',
              response: { modalities: ['text', 'audio'] },
            }));
          }
        } else if (!vadEnabled) {
          // This is the VAD enable confirmation
          vadEnabled = true;
          console.log('[OpenAI] VAD enabled - conversation active');
        }
        return;
      }

      // ========== AUDIO DELTA: Forward to Twilio ==========
      // v22: Handle BOTH old and new event names for compatibility
      if ((response.type === 'response.audio.delta' || response.type === 'response.output_audio.delta') && response.delta) {
        if (streamSid && ws.readyState === WebSocket.OPEN) {
          const audioDelta = {
            event: 'media',
            streamSid: streamSid,
            media: { payload: response.delta },
          };
          ws.send(JSON.stringify(audioDelta));
          audioChunksSent++;

          // Track timing for interruption handling
          if (!responseStartTimestampTwilio) {
            responseStartTimestampTwilio = latestMediaTimestamp;
          }

          if (response.item_id) {
            lastAssistantItem = response.item_id;
          }

          sendMark();
          
          if (audioChunksSent === 1) {
            console.log(`[Audio] First chunk sent to Twilio (streamSid: ${streamSid})`);
          }
          if (audioChunksSent % 50 === 0) {
            console.log(`[Audio] ${audioChunksSent} chunks sent to Twilio`);
          }
        } else {
          if (audioChunksSent === 0) {
            console.log(`[Audio] WARNING: Audio received but cannot send - streamSid: ${streamSid}, wsState: ${ws.readyState}`);
          }
        }
      }

      // ========== AUDIO TRANSCRIPT DONE ==========
      if (response.type === 'response.audio_transcript.done' || response.type === 'response.output_audio_transcript.done') {
        const assistantText = response.transcript || '';
        if (assistantText.trim()) {
          console.log(`[Assistant] "${assistantText}"`);
          sessionData.transcription.push({ role: 'assistant', text: assistantText, timestamp: new Date().toISOString() });
        }
      }

      // ========== RESPONSE DONE ==========
      if (response.type === 'response.done') {
        console.log(`[OpenAI] Response done (audioChunksSent: ${audioChunksSent})`);
        
        // Enable VAD after greeting
        if (!vadEnabled) {
          console.log('[OpenAI] Enabling VAD after greeting (1.5s delay)');
          setTimeout(() => {
            if (openAiWs.readyState === WebSocket.OPEN) {
              openAiWs.send(JSON.stringify({
                type: 'session.update',
                session: {
                  turn_detection: {
                    type: 'server_vad',
                    threshold: 0.55,
                    prefix_padding_ms: 400,
                    silence_duration_ms: 900,
                  },
                },
              }));
            }
          }, 1500);
        }
      }

      // ========== USER SPEECH STARTED ==========
      if (response.type === 'input_audio_buffer.speech_started') {
        console.log('[User] Speaking...');
        handleSpeechStarted();
      }

      // ========== USER TRANSCRIPTION ==========
      if (response.type === 'conversation.item.input_audio_transcription.completed') {
        const userText = response.transcript || '';
        if (userText.trim()) {
          userMessageCount++;
          console.log(`[User] [${userMessageCount}]: "${userText}"`);
          sessionData.transcription.push({ role: 'user', text: userText, timestamp: new Date().toISOString() });
          
          if (!interestNotified && userMessageCount >= 2) {
            const { interested, signal } = detectInterest(userText);
            if (interested) {
              interestNotified = true;
              console.log(`[Interest] Positive signal: "${signal}"`);
              sendInterestNotification(callSid, sessionData.contactPhone || 'unknown', signal, sessionData.transcription, scriptId);
            }
          }
        }
      }

      // ========== ERROR ==========
      if (response.type === 'error') {
        console.error(`[OpenAI] Error:`, JSON.stringify(response.error));
        
        // If error during greeting, try to enable VAD anyway
        if (!vadEnabled) {
          console.log('[OpenAI] Error during greeting, enabling VAD anyway');
          setTimeout(() => {
            if (openAiWs.readyState === WebSocket.OPEN) {
              openAiWs.send(JSON.stringify({
                type: 'session.update',
                session: {
                  turn_detection: { type: 'server_vad', threshold: 0.55, prefix_padding_ms: 400, silence_duration_ms: 900 },
                },
              }));
            }
          }, 1000);
        }
      }
    } catch (error) {
      console.error('[OpenAI] Parse error:', error.message);
    }
  });

  openAiWs.on('error', (error) => {
    console.error('[OpenAI] WebSocket error:', error.message);
  });

  openAiWs.on('close', (code) => {
    console.log(`[OpenAI] Connection closed (code: ${code})`);
    if (transcriptionSaveTimer) clearTimeout(transcriptionSaveTimer);
    if (sessionData.transcription.length > 0) {
      console.log(`[Transcription] Final save for call ${callSid} (${sessionData.transcription.length} messages)`);
      sendTranscriptionToBackend(callSid, sessionData.transcription, scriptId);
    }
  });

  // ========== Twilio WebSocket Events ==========
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());

      switch (data.event) {
        case 'start':
          streamSid = data.start.streamSid;
          callSid = data.start.callSid;
          
          // v22: Get scriptId from customParameters (preferred) or query
          const startScriptId = data.start.customParameters?.scriptId || query.scriptId;
          if (startScriptId && startScriptId !== scriptId) {
            scriptId = startScriptId;
            console.log(`[Twilio] Script ID updated from start event: ${scriptId}`);
          }
          
          sessionData.contactPhone = data.start.customParameters?.contactPhone 
            || data.start.customParameters?.to 
            || query.contactPhone 
            || data.start.customParameters?.From
            || null;
          
          console.log(`[Twilio] Stream started: ${streamSid}, Call: ${callSid}, Script: ${scriptId}, Phone: ${sessionData.contactPhone}`);
          activeSessions.set(streamSid, { twilioWs: ws, openaiWs: openAiWs, streamSid, startTime: new Date() });
          
          // v22: If we got a new scriptId, reconfigure the session with the correct script
          if (startScriptId && !scriptData) {
            fetchScript(startScriptId).then((script) => {
              if (script) {
                scriptData = script;
                console.log(`[OpenAI] Script loaded late: ${script.name}`);
                // If session is already configured but greeting hasn't been sent,
                // reconfigure with the correct script
                if (sessionConfigured && !greetingSent) {
                  configureSession();
                }
              }
            });
          }
          
          // Reset timing
          responseStartTimestampTwilio = null;
          latestMediaTimestamp = 0;
          
          scheduleTranscriptionSave();
          break;

        case 'media':
          latestMediaTimestamp = data.media.timestamp;
          audioChunksReceived++;
          if (openAiWs.readyState === WebSocket.OPEN) {
            openAiWs.send(JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: data.media.payload,
            }));
          }
          if (audioChunksReceived === 1) {
            console.log(`[Twilio] First media chunk received`);
          }
          break;

        case 'mark':
          if (markQueue.length > 0) {
            markQueue.shift();
          }
          break;

        case 'stop':
          console.log('[Twilio] Stream stopped');
          if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
          if (streamSid) activeSessions.delete(streamSid);
          break;

        default:
          console.log('[Twilio] Event:', data.event);
          break;
      }
    } catch (error) {
      console.error('[Twilio] Error:', error.message);
    }
  });

  ws.on('close', () => {
    console.log('[Twilio] Disconnected');
    if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
    if (streamSid) activeSessions.delete(streamSid);
  });
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
      version: '22.0.0',
      voiceProvider: 'OpenAI Native',
      voiceId: 'shimmer',
      activeSessions: activeSessions.size,
      uptime: Math.round(process.uptime()),
    }));
    return;
  }
  
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Realtime WebSocket Server v22\n');
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  const { pathname } = parse(req.url);
  if (pathname === '/media-stream') {
    handleTwilioConnection(ws, req);
  } else {
    console.log('[WS] Unknown path:', pathname);
    ws.close();
  }
});

server.listen(PORT, () => {
  console.log('========================================');
  console.log(`Server v22 running on port ${PORT}`);
  console.log(`Voice: OpenAI Native (shimmer)`);
  console.log(`API: ${API_BASE_URL}`);
  console.log('========================================');
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('uncaughtException', (error) => console.error('Uncaught:', error));
process.on('unhandledRejection', (reason) => console.error('Unhandled:', reason));
