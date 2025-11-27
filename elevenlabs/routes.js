import crypto from "crypto";
import { addGHLContactNote } from '../ghl/api.js';
import { sendNonFatalSlackNotification, sendNormalSlackNotification } from '../slack/notifications.js';
import { openDb, closeDb, run, get } from '../db.js';
import { executePostCallAnalysis } from '../post-call-analysis.js';
import {
  ELEVENLABS_WEBHOOK_SECRET,
  GOHIGHLEVEL_LOCATION_ID,
  ITALIAN_TIMEZONE,
  ENABLE_POST_CALL_ANALYSIS
} from '../config.js';

const SIGNATURE_TOLERANCE_MINUTES = 30;

export function registerElevenLabsRoutes(fastify) {
  // Register content type parser to preserve raw body for HMAC validation
  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, function (req, body, done) {
    try {
      // Store raw body for HMAC validation
      req.rawBody = body.toString('utf8');
      // Parse JSON for normal use
      const json = JSON.parse(req.rawBody);
      done(null, json);
    } catch (err) {
      done(err, undefined);
    }
  });

  // ---------------------------------------------------------------------------
  // ELEVENLABS POST-CALL WEBHOOK ENDPOINT WITH COMPREHENSIVE ERROR HANDLING
  // ---------------------------------------------------------------------------
  fastify.post('/elevenlabs/webhook', async (request, reply) => {
    const startTime = Date.now();
    let webhookContext = {
      requestId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      source: 'ElevenLabs Webhook',
      conversationId: null,
      contactId: null
    };

    console.log(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] Received post-call webhook at ${webhookContext.timestamp}`);

    // STEP 1: Validate request body with comprehensive error handling
    try {
      if (!request.body) {
        const error = new Error('Request body is missing or empty');
        console.error(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] ${error.message}`);
        await sendNonFatalSlackNotification(
          '❌ ElevenLabs Webhook - Missing Request Body',
          `Webhook received with no request body`,
          { requestId: webhookContext.requestId, headers: request.headers }
        ).catch(console.error);
        return reply.code(400).send({ error: 'Missing request body', requestId: webhookContext.requestId });
      }

      if (typeof request.body !== 'object') {
        const error = new Error('Request body is not a valid JSON object');
        console.error(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] ${error.message}`);
        await sendNonFatalSlackNotification(
          '❌ ElevenLabs Webhook - Invalid Request Body',
          `Webhook received with invalid JSON body`,
          { requestId: webhookContext.requestId, bodyType: typeof request.body, body: String(request.body).substring(0, 500) }
        ).catch(console.error);
        return reply.code(400).send({ error: 'Invalid JSON body', requestId: webhookContext.requestId });
      }
    } catch (bodyValidationError) {
      console.error(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] Body validation error:`, bodyValidationError);
      await sendNonFatalSlackNotification(
        '❌ ElevenLabs Webhook - Body Validation Error',
        `Unexpected error during request body validation`,
        { requestId: webhookContext.requestId, error: bodyValidationError.message }
      ).catch(console.error);
      return reply.code(400).send({ error: 'Body validation failed', requestId: webhookContext.requestId });
    }
    
    // STEP 2: HMAC signature validation with comprehensive error handling
    if (ELEVENLABS_WEBHOOK_SECRET) {
      try {
        const signature = request.headers['elevenlabs-signature'];
        if (!signature) {
          const error = new Error('Missing ElevenLabs-Signature header');
          console.error(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] ${error.message}`);
          await sendNonFatalSlackNotification(
            '🔒 ElevenLabs Webhook - Missing Signature',
            `Webhook received without required signature header. This could indicate a security issue or misconfiguration.`,
            { 
              requestId: webhookContext.requestId, 
              headers: Object.keys(request.headers),
              sourceIP: request.ip,
              userAgent: request.headers['user-agent']
            }
          ).catch(console.error);
          return reply.code(401).send({ error: 'Missing signature header', requestId: webhookContext.requestId });
        }

        // Parse signature header with error handling
        let timestamp, hash;
        try {
          const parts = signature.split(',');
          if (parts.length !== 2) {
            throw new Error(`Invalid signature format: expected 2 parts, got ${parts.length}`);
          }
          
          const timestampPart = parts[0].split('=');
          const hashPart = parts[1].split('=');
          
          if (timestampPart.length !== 2 || timestampPart[0] !== 't') {
            throw new Error(`Invalid timestamp part: ${parts[0]}`);
          }
          
          if (hashPart.length !== 2 || hashPart[0] !== 'v0') {
            throw new Error(`Invalid hash part: ${parts[1]}`);
          }
          
          timestamp = timestampPart[1];
          hash = hashPart[1];
          
          if (!timestamp || !hash) {
            throw new Error('Timestamp or hash is empty');
          }
        } catch (parseError) {
          console.error(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] Signature parsing error:`, parseError);
          await sendNonFatalSlackNotification(
            '🔒 ElevenLabs Webhook - Signature Parse Error',
            `Failed to parse signature header. This could indicate a security issue.`,
            { 
              requestId: webhookContext.requestId, 
              signature: signature,
              parseError: parseError.message,
              sourceIP: request.ip
            }
          ).catch(console.error);
          return reply.code(401).send({ error: 'Invalid signature format', requestId: webhookContext.requestId });
        }

        // Validate timestamp with error handling
        try {
          const timestampInt = parseInt(timestamp);
          if (isNaN(timestampInt)) {
            throw new Error(`Timestamp is not a valid integer: ${timestamp}`);
          }
          
          const tolerance = Math.floor(Date.now() / 1000) - (SIGNATURE_TOLERANCE_MINUTES * 60);
          if (timestampInt < tolerance) {
            const ageMinutes = Math.floor((Math.floor(Date.now() / 1000) - timestampInt) / 60);
            throw new Error(`Timestamp too old: ${ageMinutes} minutes old (tolerance: ${SIGNATURE_TOLERANCE_MINUTES} minutes)`);
          }
        } catch (timestampError) {
          console.error(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] Timestamp validation error:`, timestampError);
          await sendNonFatalSlackNotification(
            '🔒 ElevenLabs Webhook - Timestamp Validation Error',
            `Webhook timestamp validation failed. This could indicate a replay attack or clock synchronization issue.`,
            { 
              requestId: webhookContext.requestId, 
              timestamp: timestamp,
              currentTime: Math.floor(Date.now() / 1000),
              toleranceMinutes: SIGNATURE_TOLERANCE_MINUTES,
              error: timestampError.message
            }
          ).catch(console.error);
          return reply.code(401).send({ error: 'Timestamp validation failed', requestId: webhookContext.requestId });
        }

                 // Validate HMAC signature with error handling
         try {
           // Get raw body for HMAC validation - this is critical for proper signature verification
           let rawBody;
           if (request.rawBody) {
             // If Fastify provides rawBody
             rawBody = request.rawBody;
           } else if (Buffer.isBuffer(request.body)) {
             // If body is a buffer
             rawBody = request.body.toString('utf8');
           } else if (typeof request.body === 'string') {
             // If body is already a string
             rawBody = request.body;
           } else {
             // Fallback to JSON stringify (less reliable for HMAC)
             rawBody = JSON.stringify(request.body);
             console.warn(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] Using JSON.stringify for HMAC - may cause validation issues`);
           }

           // According to ElevenLabs docs: hash is HMAC of "timestamp.request_body"
           const fullPayloadToSign = `${timestamp}.${rawBody}`;
           const computedHash = crypto
             .createHmac('sha256', ELEVENLABS_WEBHOOK_SECRET)
             .update(fullPayloadToSign, 'utf8')
             .digest('hex');

           // The hash from the header should be compared directly (both should be hex strings)
           if (hash !== computedHash) {
             console.error(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] HMAC validation failed:`);
             console.error(`  Provided hash: ${hash}`);
             console.error(`  Computed hash: ${computedHash}`);
             console.error(`  Timestamp: ${timestamp}`);
             console.error(`  Raw body length: ${rawBody.length}`);
             console.error(`  Payload to sign: ${fullPayloadToSign.substring(0, 200)}...`);
             throw new Error('HMAC signature mismatch');
           }

          console.log(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] Signature validation successful`);
        } catch (hmacError) {
          console.error(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] HMAC validation error:`, hmacError);
          await sendNonFatalSlackNotification(
            '🚨 ElevenLabs Webhook - HMAC Validation Failed',
            `CRITICAL SECURITY ALERT: HMAC signature validation failed. This could indicate a security breach or unauthorized webhook attempt.`,
            { 
              requestId: webhookContext.requestId, 
              providedHash: hash,
              sourceIP: request.ip,
              userAgent: request.headers['user-agent'],
              error: hmacError.message,
              payloadSize: JSON.stringify(request.body).length
            }
          ).catch(console.error);
          return reply.code(401).send({ error: 'HMAC validation failed', requestId: webhookContext.requestId });
        }

      } catch (signatureError) {
        console.error(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] General signature validation error:`, signatureError);
        await sendNonFatalSlackNotification(
          '🔒 ElevenLabs Webhook - Signature Validation Exception',
          `Unexpected error during signature validation process`,
          { 
            requestId: webhookContext.requestId, 
            error: signatureError.message,
            stack: signatureError.stack
          }
        ).catch(console.error);
        return reply.code(401).send({ error: 'Signature validation failed', requestId: webhookContext.requestId });
      }
    } else {
      console.warn(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] No webhook secret configured - skipping signature validation`);
      await sendNonFatalSlackNotification(
        '⚠️ ElevenLabs Webhook - No Security Configured',
        `Webhook is processing without signature validation. Consider configuring ELEVENLABS_WEBHOOK_SECRET for security.`,
        { requestId: webhookContext.requestId, securityWarning: true }
      ).catch(console.error);
    }

    // STEP 3: Main webhook processing with comprehensive error handling
    try {
      const { type, data, event_timestamp } = request.body;
      
      // Validate webhook type
      if (!type) {
        throw new Error('Webhook type is missing from request body');
      }
      
      if (type !== 'post_call_transcription') {
        console.log(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] Ignoring unsupported webhook type: ${type}`);
        await sendNormalSlackNotification(
          'ElevenLabs Webhook - Unsupported Type',
          `📋 Received webhook with unsupported type: ${type}`,
          { requestId: webhookContext.requestId, type: type, supported: false }
        ).catch(console.error);
        return reply.code(200).send({ 
          status: 'ignored', 
          reason: 'unsupported_type', 
          type: type,
          requestId: webhookContext.requestId 
        });
      }

      // Validate data object
      if (!data || typeof data !== 'object') {
        throw new Error('Data object is missing or invalid in request body');
      }

      const {
        agent_id,
        conversation_id,
        status,
        transcript,
        analysis,
        conversation_initiation_client_data
      } = data;

      // Update webhook context with conversation info
      webhookContext.conversationId = conversation_id;
      
      // Validate required fields
      const missingFields = [];
      if (!conversation_id) missingFields.push('conversation_id');
      if (!agent_id) missingFields.push('agent_id');
      if (!status) missingFields.push('status');
      
      if (missingFields.length > 0) {
        throw new Error(`Missing required fields in data object: ${missingFields.join(', ')}`);
      }

      console.log(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] Processing post-call data for conversation ${conversation_id}`);
      console.log(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] Call status: ${status}, Agent ID: ${agent_id}`);

      // STEP 4: Extract and validate dynamic variables with error handling
       let dynamicVariables = {};
       let contactId, firstName, fullName, phone;
       
       try {
         dynamicVariables = conversation_initiation_client_data?.dynamic_variables || {};
         
                 // Try multiple field mappings for contact ID
        contactId = dynamicVariables.contactId || 
                   dynamicVariables.contact_id;
        
        // Try multiple field mappings for name (including ElevenLabs user_name)
        firstName = dynamicVariables.firstName || 
                   dynamicVariables.first_name || 
                   dynamicVariables.user_name;
        fullName = dynamicVariables.fullName || 
                  dynamicVariables.full_name || 
                  dynamicVariables.user_name;
        
        // Try multiple field mappings for phone
        phone = dynamicVariables.phone;
         
         // Update webhook context
         webhookContext.contactId = contactId;

         console.log(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] Extracted data - Contact ID: ${contactId}, Name: ${fullName}, Phone: ${phone}`);
         
         // Only warn if we have no contact identification at all
         if (!contactId && !conversation_id) {
           await sendNonFatalSlackNotification(
             '⚠️ ElevenLabs Webhook - No Contact Identification',
             `No contact ID or conversation ID found. This will limit functionality.`,
             { 
               requestId: webhookContext.requestId,
               conversationId: conversation_id,
               availableVariables: Object.keys(dynamicVariables)
             }
           ).catch(console.error);
         }
       } catch (extractionError) {
         console.error(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] Error extracting dynamic variables:`, extractionError);
         await sendNonFatalSlackNotification(
           '❌ ElevenLabs Webhook - Data Extraction Error',
           `Failed to extract contact information from webhook data`,
           { 
             requestId: webhookContext.requestId,
             conversationId: conversation_id,
             error: extractionError.message
           }
         ).catch(console.error);
       }

      // STEP 5: Process call outcome and create summary with error handling
      let callOutcomeText = 'Esito sconosciuto';
      let conversationSummary = 'Nessun riassunto disponibile';
      let currentDateTime;
      
      try {
        // Create timestamp with error handling
        try {
          currentDateTime = new Date().toLocaleString('it-IT', { 
            timeZone: ITALIAN_TIMEZONE,
            day: '2-digit',
            month: '2-digit', 
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
          });
        } catch (dateError) {
          console.warn(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] Date formatting error:`, dateError);
          currentDateTime = new Date().toISOString(); // Fallback to ISO string
        }

        // Determine call outcome with error handling
        try {
          if (analysis?.call_successful === 'success') {
            callOutcomeText = '✅ Chiamata completata con successo';
          } else if (analysis?.call_successful === 'failure') {
            callOutcomeText = '❌ Chiamata non riuscita';
          } else if (analysis?.call_successful === 'partial') {
            callOutcomeText = '⚠️ Chiamata parzialmente riuscita';
          }
        } catch (outcomeError) {
          console.warn(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] Error determining call outcome:`, outcomeError);
          await sendNonFatalSlackNotification(
            '⚠️ ElevenLabs Webhook - Call Outcome Processing Error',
            `Error processing call outcome data`,
            { 
              requestId: webhookContext.requestId,
              conversationId: conversation_id,
              analysis: analysis,
              error: outcomeError.message
            }
          ).catch(console.error);
        }

        // Create conversation summary with error handling
        try {
          if (analysis?.transcript_summary) {
            conversationSummary = analysis.transcript_summary;
          } else if (transcript && Array.isArray(transcript) && transcript.length > 0) {
            const userMessages = transcript.filter(msg => msg?.role === 'user').map(msg => msg?.message).filter(Boolean);
            const agentMessages = transcript.filter(msg => msg?.role === 'agent').map(msg => msg?.message).filter(Boolean);
            conversationSummary = `Conversazione con ${userMessages.length} interventi del cliente e ${agentMessages.length} risposte dell'agente.`;
          }
        } catch (summaryError) {
          console.warn(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] Error creating conversation summary:`, summaryError);
          await sendNonFatalSlackNotification(
            '⚠️ ElevenLabs Webhook - Summary Processing Error',
            `Error processing conversation summary`,
            { 
              requestId: webhookContext.requestId,
              conversationId: conversation_id,
              transcriptLength: transcript?.length,
              error: summaryError.message
            }
          ).catch(console.error);
        }
      } catch (processingError) {
        console.error(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] Error in call processing:`, processingError);
        await sendNonFatalSlackNotification(
          '❌ ElevenLabs Webhook - Call Processing Error',
          `Error during call outcome and summary processing`,
          { 
            requestId: webhookContext.requestId,
            conversationId: conversation_id,
            error: processingError.message,
            stack: processingError.stack
          }
        ).catch(console.error);
      }

             // STEP 6: Add note to GoHighLevel with comprehensive error handling
       if (contactId && contactId !== conversation_id) {
         try {
           const noteBody = `📞 RIEPILOGO CHIAMATA COMPLETATA - ${currentDateTime}\n\n` +
                            `👤 Cliente: ${fullName || firstName || 'Nome non disponibile'}\n` +
                            `📋 RIASSUNTO CONVERSAZIONE:\n${conversationSummary}\n\n` +
                            `🆔 ID Conversazione: ${conversation_id}\n` +
                            `📊 Esito: ${callOutcomeText}`;

           const result = await addGHLContactNote(GOHIGHLEVEL_LOCATION_ID, contactId, noteBody);
           
           if (result.success) {
             console.log(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] Successfully added post-call summary note for contact ${contactId}`);
           } else {
             console.error(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] Failed to add GHL note: ${result.error}`);
           }
         } catch (ghlError) {
           console.error(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] Error adding GHL note for contact ${contactId}:`, ghlError);
         }
       } else {
         console.log(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] Skipping GHL note - using conversation ID as contact ID`);
       }

      // STEP 7: Update database with comprehensive error handling
      try {
        let db = await openDb();
        
        try {
          const callRecord = await get(db, 
            'SELECT * FROM calls WHERE conversationId = ?', 
            [conversation_id]
          );
          
                     if (callRecord) {
             await run(db,
               'UPDATE calls SET status = ?, transcript_summary = ?, updated_at = CURRENT_TIMESTAMP WHERE conversationId = ?',
               [analysis?.call_successful || 'completed', analysis?.transcript_summary || null, conversation_id]
             );
             console.log(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] Updated call record for conversation ${conversation_id}`);
           } else {
             console.log(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] No call record found for conversation ${conversation_id}`);
           }
        } finally {
          await closeDb(db);
        }
      } catch (dbError) {
        console.error(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] Database error:`, dbError);
        await sendNonFatalSlackNotification(
          '❌ ElevenLabs Webhook - Database Error',
          `Failed to update call record in database for conversation ${conversation_id}`,
          { 
            requestId: webhookContext.requestId,
            conversationId: conversation_id,
            error: dbError.message,
            stack: dbError.stack
          }
        ).catch(console.error);
      }

      // STEP 8: Send concise and useful call completion notification
       try {
         // Determine notification details
         let notificationTitle, notificationEmoji;
         if (analysis?.call_successful === 'success') {
           notificationTitle = '✅ Chiamata AI Completata con Successo';
           notificationEmoji = '✅';
         } else if (analysis?.call_successful === 'failure') {
           notificationTitle = '❌ Chiamata AI Non Riuscita';
           notificationEmoji = '❌';
         } else if (analysis?.call_successful === 'partial') {
           notificationTitle = '⚠️ Chiamata AI Parzialmente Riuscita';
           notificationEmoji = '⚠️';
         } else {
           notificationTitle = '📞 Chiamata AI Completata';
           notificationEmoji = '📞';
         }

         // Build concise but informative message
         let message = `${notificationEmoji} **${notificationTitle}**\n\n`;
         message += `👤 **Cliente:** ${fullName || firstName || 'Nome non disponibile'}\n`;
         message += `📱 **Telefono:** ${phone || 'N/A'}\n`;
         message += `🕒 **Durata:** ${dynamicVariables.system__call_duration_secs || 'N/A'} secondi\n`;
         message += `📊 **Esito:** ${callOutcomeText}\n\n`;

         // Add conversation summary if meaningful
         if (conversationSummary && conversationSummary !== 'Nessun riassunto disponibile') {
           message += `📝 **Riassunto:**\n${conversationSummary}\n\n`;
         }

         // Add evaluation metrics if available
         if (analysis?.evaluation_criteria_results && typeof analysis.evaluation_criteria_results === 'object') {
           const criteriaEntries = Object.entries(analysis.evaluation_criteria_results);
           if (criteriaEntries.length > 0) {
             message += `📊 **Valutazioni:**\n`;
             criteriaEntries.forEach(([criteriaName, criteriaResult]) => {
               if (criteriaResult && typeof criteriaResult === 'object') {
                 const result = criteriaResult.result || criteriaResult.status;
                 const resultEmoji = result === 'passed' || result === 'success' ? '✅' : 
                                     result === 'failed' || result === 'failure' ? '❌' : '❓';
                 message += `${resultEmoji} ${criteriaName}: ${result || 'Unknown'}\n`;
               }
             });
             message += '\n';
           }
         }

         // Add transcript stats if available
         if (transcript && Array.isArray(transcript) && transcript.length > 0) {
           const userMessages = transcript.filter(msg => msg?.role === 'user');
           const agentMessages = transcript.filter(msg => msg?.role === 'agent');
           message += `💬 **Conversazione:** ${userMessages.length} interventi cliente, ${agentMessages.length} risposte agente\n\n`;
         }

         message += `🆔 **ID:** ${conversation_id}`;

         await sendNormalSlackNotification(
           notificationTitle,
           message,
           {
             requestId: webhookContext.requestId,
             conversationId: conversation_id,
             contactId: contactId,
             customerName: fullName || firstName || 'Nome non disponibile',
             customerPhone: phone || 'N/A',
             callOutcome: analysis?.call_successful || 'unknown',
             callDuration: dynamicVariables.system__call_duration_secs || null,
             conversationSummary: conversationSummary,
             evaluationCriteria: analysis?.evaluation_criteria_results || {},
             dataCollectionResults: analysis?.data_collection_results || {},
             transcriptLength: transcript?.length || 0
           }
         );
         
         console.log(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] Sent call completion notification to Slack`);
       } catch (slackError) {
         console.error(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] Failed to send call completion notification:`, slackError);
       }

      // STEP 9: Execute Post-Call Analysis for Missed Tool Calls
      if (ENABLE_POST_CALL_ANALYSIS) {
        try {
          console.log(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] Starting post-call analysis for conversation ${conversation_id}`);
          
          // Prepare contact information for analysis
          const contactInfo = {
            contactId: contactId,
            firstName: firstName,
            fullName: fullName,
            phone: phone,
            service: dynamicVariables.Service || dynamicVariables.service,
            fullAddress: dynamicVariables.full_address || dynamicVariables.address
          };

          // Only run analysis for successful or partial calls with valid transcript
          if ((analysis?.call_successful === 'success' || analysis?.call_successful === 'partial') && 
              transcript && Array.isArray(transcript) && transcript.length > 0 && 
              contactId && contactId !== conversation_id) {
          
          // Execute post-call analysis asynchronously to avoid blocking webhook response
          setImmediate(async () => {
            try {
              const analysisResults = await executePostCallAnalysis(transcript, contactInfo, conversation_id);
              console.log(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] Post-call analysis completed for conversation ${conversation_id}`);
              console.log(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] Analysis results:`, JSON.stringify(analysisResults, null, 2));
            } catch (analysisError) {
              console.error(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] Post-call analysis failed for conversation ${conversation_id}:`, analysisError);
              await sendNonFatalSlackNotification(
                'Post-Call Analysis Failed',
                `Post-call analysis failed for conversation ${conversation_id}`,
                {
                  requestId: webhookContext.requestId,
                  conversationId: conversation_id,
                  contactId: contactId,
                  error: analysisError.message,
                  contactInfo
                }
              ).catch(console.error);
            }
          });
          
          console.log(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] Post-call analysis initiated (running asynchronously)`);
        } else {
          let skipReason = [];
          if (analysis?.call_successful !== 'success' && analysis?.call_successful !== 'partial') {
            skipReason.push(`call not successful (${analysis?.call_successful})`);
          }
          if (!transcript || !Array.isArray(transcript) || transcript.length === 0) {
            skipReason.push('no valid transcript');
          }
          if (!contactId || contactId === conversation_id) {
            skipReason.push('no valid contact ID');
          }
          
          console.log(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] Skipping post-call analysis for conversation ${conversation_id}: ${skipReason.join(', ')}`);
        }
      } catch (analysisSetupError) {
        console.error(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] Error setting up post-call analysis:`, analysisSetupError);
        await sendNonFatalSlackNotification(
          'Post-Call Analysis Setup Failed',
          `Failed to setup post-call analysis for conversation ${conversation_id}`,
          {
            requestId: webhookContext.requestId,
            conversationId: conversation_id,
            error: analysisSetupError.message
          }
        ).catch(console.error);
        }
      } else {
        console.log(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] Post-call analysis disabled via configuration for conversation ${conversation_id}`);
      }

      // STEP 10: Log processing completion
       const processingTime = Date.now() - startTime;
       console.log(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] Successfully processed post-call webhook in ${processingTime}ms`);
      
      return reply.code(200).send({ 
        status: 'success', 
        message: 'Webhook processed successfully',
        conversation_id: conversation_id,
        requestId: webhookContext.requestId,
        processingTime: processingTime
      });

    } catch (error) {
      const processingTime = Date.now() - startTime;
      console.error(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] Critical error processing webhook:`, error);
      
      // Send comprehensive error notification
      try {
        await sendNonFatalSlackNotification(
          '🚨 CRITICAL: ElevenLabs Webhook Processing Failed',
          `Critical error occurred during webhook processing. This requires immediate attention.`,
          {
            requestId: webhookContext.requestId,
            conversationId: webhookContext.conversationId,
            contactId: webhookContext.contactId,
            error: error.message,
            stack: error.stack,
            processingTime: processingTime,
            requestBody: request.body,
            headers: request.headers,
            critical: true
          }
        );
      } catch (criticalNotificationError) {
        console.error(`[ELEVENLABS WEBHOOK] [${webhookContext.requestId}] EMERGENCY: Failed to send critical error notification:`, criticalNotificationError);
      }
      
      return reply.code(500).send({ 
        status: 'error', 
        message: 'Internal server error processing webhook',
        requestId: webhookContext.requestId,
        processingTime: processingTime
      });
    }
  });
} 