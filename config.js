import dotenv from 'dotenv';
dotenv.config();

export const GOHIGHLEVEL_CLIENT_ID = process.env.GOHIGHLEVEL_CLIENT_ID || '';
export const GOHIGHLEVEL_CLIENT_SECRET = process.env.GOHIGHLEVEL_CLIENT_SECRET || '';
export const GOHIGHLEVEL_REDIRECT_URI = process.env.GOHIGHLEVEL_REDIRECT_URI || '';
export const GOHIGHLEVEL_LOCATION_ID = process.env.GOHIGHLEVEL_LOCATION_ID || '';
export const GOHIGHLEVEL_CALENDAR_ID = process.env.GOHIGHLEVEL_CALENDAR_ID || '';
export const NO_SALES_REP_WORKFLOW_ID = 'ff439968-71dd-4c12-a25e-47ff396c1db9' || '';
export const CALL_SCHEDULED_WORKFLOW_ID = '32c22357-7416-466c-99cd-c4847a431494' || '';
export const FOLLOW_UP_WORKFLOW_ID = '43c52857-cb90-4d21-b4b3-4a23a0d48fa7' || '';

export const GOHIGHLEVEL_AUTH_URL = "https://marketplace.gohighlevel.com/oauth/chooselocation";
export const GOHIGHLEVEL_TOKEN_URL = "https://services.leadconnectorhq.com/oauth/token";
export const GOHIGHLEVEL_API_SCOPES = "calendars.readonly calendars.write calendars/events.write contacts.readonly contacts.write";

export const ITALIAN_TIMEZONE = 'Europe/Rome';

// Environment variables for OutgoingCall
export const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
export const OUTGOING_ELEVENLABS_AGENT_ID = process.env.OUTGOING_ELEVENLABS_AGENT_ID || '';
export const ELEVENLABS_WEBHOOK_SECRET = process.env.ELEVENLABS_WEBHOOK_SECRET || '';

// Service-specific ElevenLabs Agent IDs
export const PERGOLE_AGENT_ID = 'agent_01jwzv8rkxftpsgkcb0hd1fsen';
export const INFISSI_AGENT_ID = 'agent_01jyy412bmf3395f62vwzw7a02';
export const VETRATE_AGENT_ID = 'agent_01jyy40eq2f2c8e1gzrw2rryf3';

/**
 * Get the appropriate ElevenLabs agent ID based on service type
 * @param {string} service - The service type ("Infissi", "Vetrate", or "Pergole")
 * @returns {string} The agent ID to use for the service
 */
export const getAgentIdForService = (service) => {
  console.log(`[CONFIG] getAgentIdForService called with service: "${service}"`);
  
  let selectedAgentId;
  if (service === "Pergole") {
    selectedAgentId = PERGOLE_AGENT_ID;
    console.log(`[CONFIG] Service is Pergole, selected agent: "${selectedAgentId}"`);
  } else if (service === "Infissi") {
    selectedAgentId = INFISSI_AGENT_ID;
    console.log(`[CONFIG] Service is Infissi, selected agent: "${selectedAgentId}"`);
  } else if (service === "Vetrate") {
    selectedAgentId = VETRATE_AGENT_ID;
    console.log(`[CONFIG] Service is Vetrate, selected agent: "${selectedAgentId}"`);
  } else {
    selectedAgentId = OUTGOING_ELEVENLABS_AGENT_ID;
    console.log(`[CONFIG] Service "${service}" not recognized, using fallback agent: "${selectedAgentId}"`);
  }
  
  console.log(`[CONFIG] Final agent ID for service "${service}": "${selectedAgentId}"`);
  return selectedAgentId;
};

export const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
export const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';

// Service-specific phone numbers
export const OUTGOING_PHONE_NUMBER_1 = process.env.OUTGOING_PHONE_NUMBER_1 || ''; // For Vetrate and Pergole
export const OUTGOING_PHONE_NUMBER_2 = process.env.OUTGOING_PHONE_NUMBER_2 || ''; // For Infissi

// Legacy phone number (for backward compatibility)
export const OUTGOING_TWILIO_PHONE_NUMBER = process.env.OUTGOING_TWILIO_PHONE_NUMBER || '';

/**
 * Get the appropriate phone number based on service type
 * @param {string} service - The service type ("Infissi", "Vetrate", or "Pergole")
 * @returns {string} The phone number to use for the service
 */
export const getPhoneNumberForService = (service) => {
  console.log(`[CONFIG] getPhoneNumberForService called with service: "${service}"`);
  console.log(`[CONFIG] Available phone numbers - OUTGOING_PHONE_NUMBER_1: "${OUTGOING_PHONE_NUMBER_1}", OUTGOING_PHONE_NUMBER_2: "${OUTGOING_PHONE_NUMBER_2}", OUTGOING_TWILIO_PHONE_NUMBER: "${OUTGOING_TWILIO_PHONE_NUMBER}"`);
  
  let selectedNumber;
  if (service === "Infissi") {
    selectedNumber = OUTGOING_PHONE_NUMBER_2 || OUTGOING_TWILIO_PHONE_NUMBER;
    console.log(`[CONFIG] Service is Infissi, selected: "${selectedNumber}"`);
  } else if (service === "Vetrate" || service === "Pergole") {
    selectedNumber = OUTGOING_PHONE_NUMBER_1 || OUTGOING_TWILIO_PHONE_NUMBER;
    console.log(`[CONFIG] Service is ${service}, selected: "${selectedNumber}"`);
  } else {
    selectedNumber = OUTGOING_TWILIO_PHONE_NUMBER;
    console.log(`[CONFIG] Service "${service}" not recognized, using fallback: "${selectedNumber}"`);
  }
  
  console.log(`[CONFIG] Final phone number for service "${service}": "${selectedNumber}"`);
  return selectedNumber;
};

// Clean the OUTGOING_ROUTE_PREFIX by removing any quotes and setting a default
let outgoingRoutePrefix = (process.env.OUTGOING_ROUTE_PREFIX || '/outgoing').replace(/['"]/g, '');
// Ensure it starts with a forward slash
if (!outgoingRoutePrefix.startsWith('/') && !outgoingRoutePrefix.startsWith('*')) {
  outgoingRoutePrefix = '/' + outgoingRoutePrefix;
}
// Remove any empty segments that might cause double slashes
outgoingRoutePrefix = outgoingRoutePrefix.replace(/\/+/g, '/');
export const OUTGOING_ROUTE_PREFIX = outgoingRoutePrefix;

// Use the existing GOHIGHLEVEL_ variables instead of separate ones
export const LOCATION_ID = GOHIGHLEVEL_LOCATION_ID;
export const CALENDAR_ID = GOHIGHLEVEL_CALENDAR_ID;
export const PUBLIC_URL = process.env.PUBLIC_URL || '';
export const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';

// Agent User IDs Configuration
export const INFISSI_VETRATE_AGENT_USER_ID = process.env.INFISSI_VETRATE_AGENT_USER_ID || '';
export const PERGOLE_AGENT_USER_ID = process.env.PERGOLE_AGENT_USER_ID || '';

// Service to UserID mapping
export const SERVICE_TO_USER_IDS = {
  "Infissi": [INFISSI_VETRATE_AGENT_USER_ID].filter(id => id),
  "Vetrate": [INFISSI_VETRATE_AGENT_USER_ID].filter(id => id),
  "Pergole": [PERGOLE_AGENT_USER_ID].filter(id => id)
};

// Province-specific service mapping (if different agents cover different provinces)
// This can be extended as your business grows to different regions
export const PROVINCE_SERVICE_TO_USER_IDS = {
  
};

// Meeting/Appointment Configuration
export const DEFAULT_APPOINTMENT_ADDRESS = process.env.DEFAULT_APPOINTMENT_ADDRESS || 'Client Address - To Be Confirmed'; // Default actual address when client address not available

// Post-Call Analysis Configuration
export const ENABLE_POST_CALL_ANALYSIS = process.env.ENABLE_POST_CALL_ANALYSIS !== 'false'; // Enable by default, set to 'false' to disable