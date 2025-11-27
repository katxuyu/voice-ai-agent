import WebSocket from "ws";
import Twilio from "twilio";
import xmlEscape from "xml-escape";
import fetch from "node-fetch";
import { openDb, closeDb, run, get as getDbRecord } from './db.js';

async function getSignedUrl(ELEVENLABS_API_KEY, INCOMING_ELEVENLABS_AGENT_ID) {
  console.log('[ELEVENLABS] Requesting signed URL from ElevenLabs API...');
  const elevenlabsUrl = `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${INCOMING_ELEVENLABS_AGENT_ID}`;
  const response = await fetch(elevenlabsUrl, {
    method: "GET",
    headers: {
      "xi-api-key": ELEVENLABS_API_KEY,
      "Content-Type": "application/json"
    }
  });
  if (!response.ok) {
    const errorMessage = `Failed to get signed URL from ElevenLabs API: ${response.status} ${response.statusText}`;
    console.error('[ELEVENLABS] ' + errorMessage);
    throw new Error(errorMessage);
  }
  console.log('[ELEVENLABS] Successfully received signed URL response');
  const data = await response.json();
  console.log('[ELEVENLABS] Returning signed URL for WebSocket connection');
  return data.signed_url;
}

// --- DB Helpers for incoming_calls table ---

async function getIncomingCallData(callSid) {
  let db;
  try {
    if (!callSid) {
      console.error('CallSid is required for getIncomingCallData');
      return null;
    }
    db = await openDb();
    const query = "SELECT * FROM incoming_calls WHERE callSid = ?";
    const row = await getDbRecord(db, query, [callSid]);
    if (!row) {
      return null;
    }
    return row;
  } catch (error) {
    console.error(`Error getting incoming call data for CallSid ${callSid} from SQLite:`, error);
    return null;
  } finally {
    if (db) await closeDb(db);
  }
}

async function setIncomingCallData(callSid, data) {
  let db;
  try {
    if (!callSid) {
      console.error('CallSid is required for setIncomingCallData');
      return;
    }
    if (!data || typeof data !== 'object') {
      console.error('Valid data object is required for setIncomingCallData');
      return;
    }

    db = await openDb();
    
    const columns = [
      'callSid', 'caller_number', 'callee_number', 'status', 'created_at',
      'signedUrl', 'availableSlots', 'conversationId'
    ];

    const fields = [];
    const values = [];
    const placeholders = [];

    // Ensure callSid is part of the data if not already
    if (!data.hasOwnProperty('callSid')) {
        data.callSid = callSid;
    }

    for (const col of columns) {
      if (data.hasOwnProperty(col)) {
        fields.push(col);
        values.push(data[col]);
        placeholders.push('?');
      }
    }
    
    if (fields.length === 0) {
        console.error('No valid fields to insert/update for setIncomingCallData', callSid);
        return;
    }

    const sql = `INSERT OR REPLACE INTO incoming_calls (${fields.join(', ')}) VALUES (${placeholders.join(', ')})`;
    await run(db, sql, values);

  } catch (error) {
    console.error(`Error setting incoming call data for ${callSid} in SQLite:`, error);
    throw error;
  } finally {
    if (db) await closeDb(db);
  }
}

async function updateIncomingCallData(callSid, dataToUpdate) {
  let db;
  try {
    if (!callSid || !dataToUpdate || typeof dataToUpdate !== 'object' || Object.keys(dataToUpdate).length === 0) {
      console.error('CallSid and valid dataToUpdate object are required for updateIncomingCallData');
      return;
    }

    db = await openDb();
    const fields = [];
    const values = [];
    
    for (const key in dataToUpdate) {
      if (dataToUpdate.hasOwnProperty(key)) {
        fields.push(`${key} = ?`);
        values.push(dataToUpdate[key]);
      }
    }

    if (fields.length === 0) {
      console.error('No fields to update for CallSid:', callSid);
      return;
    }

    values.push(callSid);
    const sql = `UPDATE incoming_calls SET ${fields.join(', ')} WHERE callSid = ?`;
    await run(db, sql, values);
  } catch (error) {
    console.error(`Error updating incoming call data for CallSid ${callSid} in SQLite:`, error);
    throw error;
  } finally {
    if (db) await closeDb(db);
  }
}

async function deleteIncomingCallData(callSid) {
  let db;
  try {
    if (!callSid) {
      console.error('CallSid required for deleteIncomingCallData');
      return;
    }
    db = await openDb();
    await run(db, `DELETE FROM incoming_calls WHERE callSid = ?`, [callSid]);
  } catch (error) {
    console.error(`Error deleting incoming call data for CallSid ${callSid} from SQLite:`, error);
    throw error;
  } finally {
    if (db) await closeDb(db);
  }
}

// ---------------------------------------------------------------------------
// MAIN INBOUND CALL HANDLING FUNCTION
// ---------------------------------------------------------------------------
export function IncomingCall(fastify) {
  const {
    ELEVENLABS_API_KEY,
    INCOMING_ELEVENLABS_AGENT_ID,
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    INCOMING_ROUTE_PREFIX: INCOMING_ROUTE_PREFIX_RAW,
    PUBLIC_URL,
    PORT
  } = process.env;

  // Clean the INCOMING_ROUTE_PREFIX by removing any quotes and setting a default
  let INCOMING_ROUTE_PREFIX = (INCOMING_ROUTE_PREFIX_RAW || '/incoming').replace(/['"]/g, '');
  
  // Ensure it starts with a forward slash
  if (!INCOMING_ROUTE_PREFIX.startsWith('/') && !INCOMING_ROUTE_PREFIX.startsWith('*')) {
    INCOMING_ROUTE_PREFIX = '/' + INCOMING_ROUTE_PREFIX;
  }
  
  // Remove any empty segments that might cause double slashes
  INCOMING_ROUTE_PREFIX = INCOMING_ROUTE_PREFIX.replace(/\/+/g, '/');
  
  console.log("INCOMING_ROUTE_PREFIX_RAW:", JSON.stringify(INCOMING_ROUTE_PREFIX_RAW));
  console.log("INCOMING_ROUTE_PREFIX cleaned:", JSON.stringify(INCOMING_ROUTE_PREFIX));

  const requiredEnvVars = {
    ELEVENLABS_API_KEY, 
    INCOMING_ELEVENLABS_AGENT_ID,
    TWILIO_ACCOUNT_SID, 
    TWILIO_AUTH_TOKEN,
    INCOMING_ROUTE_PREFIX, 
    PUBLIC_URL, 
    PORT
  };

  for (const [key, value] of Object.entries(requiredEnvVars)) {
    if (!value) {
      console.error(`Missing required environment variable for inbound calls: ${key}`);
      throw new Error(`Missing required environment variable for inbound calls: ${key}`);
    }
  }
  
  console.log("Inbound Call System Initializing. Key ENV VARS Loaded.");
  console.log("PUBLIC_URL:", PUBLIC_URL);
  console.log("INCOMING_ROUTE_PREFIX:", INCOMING_ROUTE_PREFIX);
  console.log("PORT:", PORT);

  // ---------------------------------------------------------------------------
  // 1. HTTP ENDPOINT FOR INCOMING CALLS (from Twilio)
  // This endpoint generates TwiML to connect the call to the media stream.
  // ---------------------------------------------------------------------------
  fastify.post(`${INCOMING_ROUTE_PREFIX}/incoming-call`, async (request, reply) => {
    const twilioCallSid = request.body.CallSid;
    const callerNumber = request.body.From;
    const calledNumber = request.body.To;

    console.log(`[TWILIO INBOUND] Received call on ${calledNumber} from ${callerNumber} (Twilio Call SID: ${twilioCallSid})`);

    if (!twilioCallSid || !callerNumber || !calledNumber) {
      console.error("[TWILIO INBOUND] Missing CallSid, From, or To in request. Body:", request.body);
      const twimlError = new Twilio.twiml.VoiceResponse();
      twimlError.say("We are currently unable to process your call due to missing call information.");
      twimlError.hangup();
      return reply.type("text/xml").send(twimlError.toString());
    }

    try {
      // 1. Fetch GHL Slots
      let availableSlotsString = "Slot information could not be retrieved at this time.";
      let slotsCount = 0;
      try {
        const internalSlotsUrl = `http://localhost:${PORT}/availableSlotsInbound`;
        console.log(`[TWILIO INBOUND ${twilioCallSid}] Calling internal endpoint for formatted GHL Slots: ${internalSlotsUrl}`);
        const slotsResponse = await fetch(internalSlotsUrl);
        
        if (slotsResponse.ok) {
          const slotsResult = await slotsResponse.json();
          if (slotsResult && slotsResult.status === "success") {
            availableSlotsString = slotsResult.formattedString;
            slotsCount = slotsResult.count;
            console.log(`[TWILIO INBOUND ${twilioCallSid}] Fetched GHL Slots: ${slotsCount} slots found.`);
          } else {
            console.warn(`[TWILIO INBOUND ${twilioCallSid}] Internal slots endpoint responded but indicated an issue: `, slotsResult?.message || 'No message');
          }
        } else {
          const errorText = await slotsResponse.text();
          console.error(`[TWILIO INBOUND ${twilioCallSid}] Error calling internal slots endpoint: ${slotsResponse.status} - ${errorText}`);
        }
      } catch (internalFetchError) {
        console.error(`[TWILIO INBOUND ${twilioCallSid}] Exception calling internal GHL slots endpoint:`, internalFetchError);
        const { sendNonFatalSlackNotification } = await import('./slack/notifications.js');
        sendNonFatalSlackNotification(
          'Incoming Call - GHL Slots API Error',
          `Exception calling internal GHL slots endpoint for incoming call`,
          {
            twilioCallSid,
            callerNumber,
            calledNumber,
            error: internalFetchError.message,
            stack: internalFetchError.stack,
            endpoint: 'internal_slots_api'
          }
        ).catch(console.error);
      }

      // 2. Get ElevenLabs Signed URL
      let elevenLabsSignedUrl;
      try {
        elevenLabsSignedUrl = await getSignedUrl(ELEVENLABS_API_KEY, INCOMING_ELEVENLABS_AGENT_ID);
        console.log(`[TWILIO INBOUND ${twilioCallSid}] Obtained ElevenLabs signed URL.`);
      } catch (elevenLabsError) {
        console.error(`[TWILIO INBOUND ${twilioCallSid}] Failed to get ElevenLabs signed URL:`, elevenLabsError);
        const { sendNonFatalSlackNotification } = await import('./slack/notifications.js');
        sendNonFatalSlackNotification(
          'Incoming Call - ElevenLabs URL Error',
          `Failed to get ElevenLabs signed URL for incoming call`,
          {
            twilioCallSid,
            callerNumber,
            calledNumber,
            error: elevenLabsError.message,
            stack: elevenLabsError.stack,
            service: 'elevenlabs_signed_url'
          }
        ).catch(console.error);
        const twimlError = new Twilio.twiml.VoiceResponse();
        twimlError.say("There was an issue connecting to our AI voice service. Please try again later.");
        twimlError.hangup();
        return reply.type("text/xml").send(twimlError.toString());
      }

      // 3. Store initial call data in SQLite
      const callDataToStore = {
        callSid: twilioCallSid,
        caller_number: callerNumber,
        callee_number: calledNumber,
        status: 'initiated',
        created_at: new Date().toISOString(),
        signedUrl: elevenLabsSignedUrl,
        availableSlots: availableSlotsString
      };
      
      try {
        await setIncomingCallData(twilioCallSid, callDataToStore);
        console.log(`[TWILIO INBOUND ${twilioCallSid}] Initial call data stored in SQLite.`);
      } catch (dbError) {
        console.error(`[TWILIO INBOUND ${twilioCallSid}] SQLite error storing initial call data:`, dbError);
        const { sendNonFatalSlackNotification } = await import('./slack/notifications.js');
        sendNonFatalSlackNotification(
          'Incoming Call - Database Error',
          `SQLite error storing initial call data for incoming call`,
          {
            twilioCallSid,
            callerNumber,
            calledNumber,
            error: dbError.message,
            stack: dbError.stack,
            operation: 'store_initial_call_data'
          }
        ).catch(console.error);
        const twimlError = new Twilio.twiml.VoiceResponse();
        twimlError.say("Internal server error during call setup.");
        twimlError.hangup();
        return reply.type("text/xml").send(twimlError.toString());
      }

      // 4. Generate TwiML to connect to WebSocket media stream
      const twiml = new Twilio.twiml.VoiceResponse();
      const connect = twiml.connect();
      const streamUrl = `wss://${PUBLIC_URL.replace(/^https?:\/\//, '')}${INCOMING_ROUTE_PREFIX}/inbound-media-stream`;
      
      console.log(`[TWILIO INBOUND ${twilioCallSid}] Instructing Twilio to connect to WebSocket: ${streamUrl}`);
      const stream = connect.stream({ url: streamUrl });

      stream.parameter({ name: 'callSid', value: xmlEscape(twilioCallSid) }); 
      stream.parameter({ name: 'callerNumber', value: xmlEscape(callerNumber) });

      reply.type("text/xml").send(twiml.toString());
      console.log(`[TWILIO INBOUND ${twilioCallSid}] TwiML response sent to Twilio to connect media stream.`);

    } catch (error) {
      console.error(`[TWILIO INBOUND ${twilioCallSid}] Error in /incoming-call handler:`, error);
      const { sendNonFatalSlackNotification } = await import('./slack/notifications.js');
      sendNonFatalSlackNotification(
        'Incoming Call - Handler Error',
        `Critical error in incoming call handler`,
        {
          twilioCallSid,
          callerNumber,
          calledNumber,
          error: error.message,
          stack: error.stack,
          handler: '/incoming-call',
          critical: true
        }
      ).catch(console.error);
      if (twilioCallSid) {
        try {
            await updateIncomingCallData(twilioCallSid, { status: 'error_incoming_handler' });
        } catch (statusUpdateError) {
            console.error(`[TWILIO INBOUND ${twilioCallSid}] Further error trying to update status on error:`, statusUpdateError);
        }
      }
      const twimlError = new Twilio.twiml.VoiceResponse();
      twimlError.say("Internal server error.");
      twimlError.hangup();
      reply.type("text/xml").send(twimlError.toString());
    }
  });

  // ---------------------------------------------------------------------------
  // 2. WEBSOCKET ENDPOINT FOR INBOUND MEDIA STREAMING
  // ---------------------------------------------------------------------------
  fastify.register(async (fastifyInstance) => {
    fastifyInstance.get(`${INCOMING_ROUTE_PREFIX}/inbound-media-stream`, { websocket: true }, (ws, request) => {
      console.info("[SERVER WEBSOCKET] Client (Twilio) attempting to connect to INBOUND media stream.");
      
      const connectionState = {
        streamSid: null,
        twilioCallSid: null,
        elevenLabsWs: null,
        callerIdentifier: "Unknown Caller", 
        availableSlotsForAI: "Availability not determined."
      };

      const setupElevenLabsConnection = async () => {
        if (!connectionState.twilioCallSid) {
            console.error(`[ELEVENLABS SETUP ${connectionState.twilioCallSid}] Twilio CallSid is not available. Cannot setup ElevenLabs.`);
            ws.close();
            return;
        }
        console.log(`[ELEVENLABS SETUP ${connectionState.twilioCallSid}] Starting setup.`);

        try {
          const callData = await getIncomingCallData(connectionState.twilioCallSid);

          if (!callData) {
            console.error(`[ELEVENLABS SETUP ${connectionState.twilioCallSid}] CRITICAL: No call data found in DB for Twilio CallSid. Terminating connection.`);
            ws.close();
            return;
          }

          let signedUrlToUse = callData.signedUrl;
          if (!signedUrlToUse) {
             console.log(`[ELEVENLABS SETUP ${connectionState.twilioCallSid}] Signed URL not in DB, attempting to fetch fresh one.`);
             try {
                signedUrlToUse = await getSignedUrl(ELEVENLABS_API_KEY, INCOMING_ELEVENLABS_AGENT_ID);
                await updateIncomingCallData(connectionState.twilioCallSid, { signedUrl: signedUrlToUse });
             } catch (fetchError) {
                console.error(`[ELEVENLABS SETUP ${connectionState.twilioCallSid}] Failed to fetch fresh signed URL:`, fetchError);
                ws.close();
                return;
             }
          }
          
          if (callData.caller_number) connectionState.callerIdentifier = callData.caller_number; 
          if (callData.availableSlots) connectionState.availableSlotsForAI = callData.availableSlots;

          connectionState.elevenLabsWs = new WebSocket(signedUrlToUse);

          connectionState.elevenLabsWs.on("open", () => {
            console.log(`[ElevenLabs ${connectionState.twilioCallSid}] Connected to Conversational AI.`);
            updateIncomingCallData(connectionState.twilioCallSid, { status: 'elevenlabs_connected' });

            const initialConfig = {
              type: "conversation_initiation_client_data",
              dynamic_variables: {
                callerIdentifier: connectionState.callerIdentifier,
                nowDate: new Date().toLocaleDateString('en-GB', {
                  weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric',
                  hour: '2-digit', minute: '2-digit'
                }).replace(/[/]/g, '-'),
                availableSlots: connectionState.availableSlotsForAI
              }
            };
            console.log(`[ElevenLabs ${connectionState.twilioCallSid}] Sending initial config:`, JSON.stringify(initialConfig, null, 2));
            connectionState.elevenLabsWs.send(JSON.stringify(initialConfig));
          });

          connectionState.elevenLabsWs.on("message", async (data) => {
            try {
              const message = JSON.parse(data);
              switch (message.type) {
                case "conversation_initiation_metadata":
                  const conversationId = message.conversation_initiation_metadata_event?.conversation_id;
                  console.log(`[ElevenLabs ${connectionState.twilioCallSid}] Received conversationId: ${conversationId}`);
                  if (connectionState.twilioCallSid && conversationId) {
                    try {
                      await updateIncomingCallData(connectionState.twilioCallSid, { conversationId, status: 'elevenlabs_conversation_started' }); 
                      console.log(`[ElevenLabs ${connectionState.twilioCallSid}] Saved conversationId to SQLite.`);
                    } catch (sqliteError) {
                      console.error(`[ElevenLabs ${connectionState.twilioCallSid}] Failed to save conversationId to SQLite:`, sqliteError);
                    }
                  }
                  break;
                case "audio":
                  let payload;
                  if (message.audio?.chunk) payload = message.audio.chunk;
                  else if (message.audio_event?.audio_base_64) payload = message.audio_event.audio_base_64;
                  
                  if (connectionState.streamSid && payload) {
                    const audioData = {
                      event: "media",
                      streamSid: connectionState.streamSid,
                      media: { payload }
                    };
                    try {
                      // Add connection check to prevent audio rushing
                      if (ws.readyState === ws.OPEN) {
                        ws.send(JSON.stringify(audioData));
                      }
                    } catch (sendError) {
                      console.error(`[ElevenLabs ${connectionState.twilioCallSid}] Failed to send audio data to Twilio:`, sendError);
                    }
                  }
                  break;
                case "interruption":
                  console.log(`[ElevenLabs ${connectionState.twilioCallSid}] Received interruption event. Sending clear to Twilio.`);
                  if (connectionState.streamSid) {
                      ws.send(JSON.stringify({ event: "clear", streamSid: connectionState.streamSid }));
                  }
                  break;
                case "ping":
                  if (message.ping_event?.event_id && connectionState.elevenLabsWs.readyState === WebSocket.OPEN) {
                    connectionState.elevenLabsWs.send(JSON.stringify({ type: "pong", event_id: message.ping_event.event_id }));
                  }
                  break;
                default:
                  console.log(`[ElevenLabs ${connectionState.twilioCallSid}] Received unhandled message type: ${message.type}`);
              }
            } catch (error) {
              console.error(`[ElevenLabs ${connectionState.twilioCallSid}] Error processing message:`, error);
            }
          });

          connectionState.elevenLabsWs.on("error", (error) => {
            console.error(`[ElevenLabs ${connectionState.twilioCallSid}] WebSocket error:`, error);
          });

          connectionState.elevenLabsWs.on("close", (code, reason) => {
            console.log(`[ElevenLabs ${connectionState.twilioCallSid}] WebSocket closed with code ${code}: ${reason?.toString()}`);
          });

        } catch (error) {
          console.error(`[ELEVENLABS SETUP ${connectionState.twilioCallSid}] Error:`, error);
          if (ws.readyState === WebSocket.OPEN) {
             // Inform Twilio/caller that AI connection failed
          }
        }
      };

      ws.on("message", async (message) => {
        try {
          const msg = JSON.parse(message);
          switch (msg.event) {
            case "start":
              console.log(`[TWILIO MEDIA ${connectionState.twilioCallSid || 'PRE-ASSIGN'}] Received 'start' event:`, JSON.stringify(msg.start, null, 2));
              connectionState.streamSid = msg.start.streamSid;

              if (msg.start.customParameters && msg.start.customParameters.callSid) {
                connectionState.twilioCallSid = msg.start.customParameters.callSid;
              } else {
                 connectionState.twilioCallSid = msg.start.callSid; 
              }
              
              if (!connectionState.twilioCallSid) {
                  console.error("[TWILIO MEDIA] CRITICAL: Twilio CallSid not found in 'start' event. Cannot proceed.");
                  ws.close(); 
                  return;
              }
              console.log(`[TWILIO MEDIA ${connectionState.twilioCallSid}] Stream started. StreamSid: ${connectionState.streamSid}.`);
              try {
                  await updateIncomingCallData(connectionState.twilioCallSid, { status: 'media_streaming_active' });
              } catch (dbError) {
                  console.error(`[TWILIO MEDIA ${connectionState.twilioCallSid}] Error updating status to media_streaming_active:`, dbError);
              }
              
              await setupElevenLabsConnection();
              break;
            case "media":
              if (connectionState.elevenLabsWs?.readyState === WebSocket.OPEN) {
                connectionState.elevenLabsWs.send(JSON.stringify({
                  type: "user_audio",
                  user_audio_chunk: msg.media.payload
                }));
              }
              break;
            case "stop":
              console.log(`[TWILIO MEDIA ${connectionState.twilioCallSid}] Stream ${connectionState.streamSid} ended by Twilio.`);
              if (connectionState.elevenLabsWs?.readyState === WebSocket.OPEN) {
                connectionState.elevenLabsWs.send(JSON.stringify({ type: "conversation_end" }));
                connectionState.elevenLabsWs.close();
              }
              try {
                  await updateIncomingCallData(connectionState.twilioCallSid, { status: 'media_stream_stopped' });
              } catch (dbError) {
                  console.error(`[TWILIO MEDIA ${connectionState.twilioCallSid}] Error updating status to media_stream_stopped:`, dbError);
              }
              break;
            case "mark": 
                console.log(`[TWILIO MEDIA ${connectionState.twilioCallSid}] Received mark event: ${msg.mark.name}`);
              break;
            default:
              console.log(`[TWILIO MEDIA ${connectionState.twilioCallSid}] Unhandled event: ${msg.event}`);
          }
        } catch (error) {
          console.error(`[TWILIO MEDIA ${connectionState.twilioCallSid}] Error processing message:`, error);
        }
      });

      ws.on("close", () => {
        console.log(`[TWILIO MEDIA ${connectionState.twilioCallSid}] Twilio client WebSocket connection closed.`);
        if (connectionState.elevenLabsWs?.readyState === WebSocket.OPEN || connectionState.elevenLabsWs?.readyState === WebSocket.CONNECTING) {
          connectionState.elevenLabsWs.close();
          console.log(`[ElevenLabs ${connectionState.twilioCallSid}] Connection closed due to Twilio client disconnect.`);
        }
        if (connectionState.twilioCallSid) {
            updateIncomingCallData(connectionState.twilioCallSid, { status: 'twilio_websocket_closed' })
                .catch(err => console.error(`[TWILIO MEDIA ${connectionState.twilioCallSid}] Error updating status on close:`, err));
        }
      });

      ws.on("error", (error) => {
        console.error(`[TWILIO MEDIA ${connectionState.twilioCallSid}] Twilio client WebSocket error: ${error.message}.`);
        if (connectionState.elevenLabsWs?.readyState === WebSocket.OPEN || connectionState.elevenLabsWs?.readyState === WebSocket.CONNECTING) {
          connectionState.elevenLabsWs.close();
        }
        if (connectionState.twilioCallSid) {
            updateIncomingCallData(connectionState.twilioCallSid, { status: 'twilio_websocket_error' })
                .catch(err => console.error(`[TWILIO MEDIA ${connectionState.twilioCallSid}] Error updating status on error:`, err));
        }
      });
    });
  });

  // ---------------------------------------------------------------------------
  // 3. CALL STATUS ENDPOINT (Receives status updates from Twilio)
  // ---------------------------------------------------------------------------
  fastify.post(`${INCOMING_ROUTE_PREFIX}/inbound-call-status`, async (request, reply) => {
    const { CallSid, CallStatus, ErrorCode, From, To } = request.body;
    console.log(`[TWILIO STATUS ${CallSid}] Received status: ${CallStatus}`, request.body);

    if (!CallSid) {
      console.warn("[TWILIO STATUS] Received status update without CallSid.");
      return reply.code(200).send(); 
    }

    try {
      const callData = await getIncomingCallData(CallSid);
      
      if (!callData) {
        console.warn(`[TWILIO STATUS ${CallSid}] No call data found in SQLite for Twilio CallSid. Status: ${CallStatus}. This might be for a different call flow or a lookup issue.`);
        return reply.code(200).send();
      }
      
      console.log(`[TWILIO STATUS ${CallSid}] Matched Twilio CallSid in database.`);

      await updateIncomingCallData(CallSid, { status: `twilio_${CallStatus}`.toLowerCase() });

      const terminalStatuses = ["completed", "failed", "canceled", "busy", "no-answer"];
      if (terminalStatuses.includes(CallStatus.toLowerCase())) {
        console.log(`[TWILIO STATUS ${CallSid}] Call reached terminal Twilio status: ${CallStatus}. Cleaning up data.`);
        setTimeout(async () => {
            try {
                await deleteIncomingCallData(CallSid);
                console.log(`[TWILIO STATUS ${CallSid}] SQLite data cleaned up for terminal call.`);
            } catch (dbDeleteError) {
                console.error(`[TWILIO STATUS ${CallSid}] Error cleaning up SQLite data:`, dbDeleteError);
            }
        }, 10000);
      }
      if (CallStatus.toLowerCase() === "failed" && ErrorCode) {
          console.error(`[TWILIO STATUS ${CallSid}] Call failed with Twilio error code ${ErrorCode}. Details: https://www.twilio.com/docs/api/errors/${ErrorCode}`);
      }

    } catch (error) {
      console.error(`[TWILIO STATUS ${CallSid}] Error processing Twilio status update:`, error);
    }
    
    reply.code(200).send(); 
  });

}
