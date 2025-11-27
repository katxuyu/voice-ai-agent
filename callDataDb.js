import { openDb, closeDb, run, get as getDbRecord } from './db.js';

// Helper functions to store, retrieve, and delete call data in SQLite
export async function getCallData(callSid) {
  let db;
  try {
    if (!callSid) {
      console.error('CallSid is required for getCallData');
      return null;
    }
    db = await openDb();
    const row = await getDbRecord(db, "SELECT *, strftime('%s', created_at) as created_at_unix FROM calls WHERE callSid = ?", [callSid]);
    if (row) {
      if (row.retry_count !== null && row.retry_count !== undefined) {
        row.retry_count = Number(row.retry_count);
      }
      if (row.first_attempt_timestamp) {
        row.first_attempt_timestamp = new Date(row.first_attempt_timestamp);
      }
    } else {
      console.log(`No record found for callSid: ${callSid} in calls table`);
      return null;
    }
    return row;
  } catch (error) {
    console.error(`Error getting call data for ${callSid} from SQLite:`, error);
    throw error;
  } finally {
    if (db) await closeDb(db);
  }
}

export async function getCallDataByContactId(contactId) {
  let db;
  try {
    if (!contactId) {
      console.error('ContactId is required for getCallDataByContactId');
      return null;
    }
    db = await openDb();
    const { all } = await import('./db.js');
    const rows = await all(db, "SELECT *, strftime('%s', created_at) as created_at_unix FROM calls WHERE contactId = ? ORDER BY created_at DESC", [contactId]);
    
    if (rows && rows.length > 0) {
      // Process each row similar to getCallData
      rows.forEach(row => {
        if (row.retry_count !== null && row.retry_count !== undefined) {
          row.retry_count = Number(row.retry_count);
        }
        if (row.first_attempt_timestamp) {
          row.first_attempt_timestamp = new Date(row.first_attempt_timestamp);
        }
      });
      console.log(`Found ${rows.length} call record(s) for contactId: ${contactId}`);
    } else {
      console.log(`No records found for contactId: ${contactId} in calls table`);
      return [];
    }
    return rows || [];
  } catch (error) {
    console.error(`Error getting call data for contactId ${contactId} from SQLite:`, error);
    throw error;
  } finally {
    if (db) await closeDb(db);
  }
}

export async function setCallData(callSid, data) {
  let db;
  try {
    if (!callSid) {
      console.error('CallSid is required for setCallData');
      return;
    }
    if (!data || typeof data !== 'object') {
      console.error('Valid data object is required for setCallData');
      return;
    }

    db = await openDb();
    const flatData = { ...data }; // Use data directly

    // Ensure all keys in flatData exist as columns or handle them appropriately
    const columns = [
      'callSid', 'to', 'contactId', 'retry_count', 'status', 'created_at',
      'signedUrl',
      'fullName', 'firstName', 'email', 'answeredBy', 'availableSlots', 'conversationId',
      'first_attempt_timestamp', // Ensure this is included
      'service', // Add service field
      'province' // Add province field for AI context
    ];

    const fields = [];
    const values = [];
    const placeholders = [];

    // Always include callSid first
    fields.push('callSid');
    values.push(callSid);
    placeholders.push('?');

    for (const col of columns) {
      if (col !== 'callSid' && flatData.hasOwnProperty(col)) {
        if (col === 'to') {
          fields.push('"to"'); // Properly quote the "to" column
        } else {
          fields.push(col);
        }
        values.push(flatData[col]);
        placeholders.push('?');
      }
    }
    
    if (fields.length === 0) {
        console.error('No valid fields to insert/update for setCallData', callSid);
        return;
    }

    const sql = `INSERT OR REPLACE INTO calls (${fields.join(', ')}) VALUES (${placeholders.join(', ')})`;
    await run(db, sql, values);

  } catch (error) {
    console.error(`Error setting call data for ${callSid} in SQLite:`, error);
    throw error;
  } finally {
    if (db) await closeDb(db);
  }
}

export async function updateCallData(callSid, dataToUpdate) {
  let db;
  try {
    if (!callSid || !dataToUpdate || typeof dataToUpdate !== 'object' || Object.keys(dataToUpdate).length === 0) {
      console.error('CallSid and valid dataToUpdate object are required for updateCallData');
      return;
    }

    db = await openDb();
    const fields = [];
    const values = [];

    for (const key in dataToUpdate) {
      if (dataToUpdate.hasOwnProperty(key)) {
        if (key === 'to') {
          fields.push(`"to" = ?`); // Properly quote the "to" column in SET clause
        } else {
          fields.push(`${key} = ?`);
        }
        values.push(dataToUpdate[key]);
      }
    }

    if (fields.length === 0) {
      console.error('No fields to update for callSid:', callSid);
      return;
    }

    values.push(callSid); // For the WHERE clause
    const sql = `UPDATE calls SET ${fields.join(', ')} WHERE callSid = ?`;
    await run(db, sql, values);
  } catch (error) {
    console.error(`Error updating call data for ${callSid} in SQLite:`, error);
    throw error;
  } finally {
    if (db) await closeDb(db);
  }
} 