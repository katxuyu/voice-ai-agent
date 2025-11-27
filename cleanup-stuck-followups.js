#!/usr/bin/env node

/**
 * Utility script to clean up stuck follow-ups
 * Run this to immediately clean up follow-ups that are stuck in infinite retry loops
 */

import { openDb, closeDb, all, run } from './db.js';
import { sendNonFatalSlackNotification } from './slack/notifications.js';

async function cleanupStuckFollowUps(specificContactId = null) {
    let db;
    try {
        console.log('🔍 Checking for stuck follow-ups...');
        
        db = await openDb();
        
        let query = 'SELECT * FROM follow_ups WHERE status = ? ORDER BY follow_up_at_utc ASC';
        let params = ['pending'];
        
        if (specificContactId) {
            query = 'SELECT * FROM follow_ups WHERE status = ? AND contact_id = ? ORDER BY follow_up_at_utc ASC';
            params = ['pending', specificContactId];
            console.log(`🎯 Looking specifically for contact: ${specificContactId}`);
        }
        
        const allFollowUps = await all(db, query, params);
        
        if (allFollowUps.length === 0) {
            console.log('✅ No stuck follow-ups found');
            return;
        }
        
        console.log(`📋 Found ${allFollowUps.length} pending follow-up(s):`);
        
        const now = new Date();
        let cleanedUp = 0;
        
        for (const followUp of allFollowUps) {
            const scheduledTime = new Date(followUp.follow_up_at_utc);
            const hoursOverdue = (now - scheduledTime) / (1000 * 60 * 60);
            
            console.log(`   Contact: ${followUp.contact_id}, Scheduled: ${followUp.follow_up_at_utc}, Hours overdue: ${hoursOverdue.toFixed(1)}, Service: ${followUp.service || 'N/A'}, Province: ${followUp.province || 'N/A'}`);
            
            // Clean up follow-ups that are more than 1 hour overdue (likely stuck)
            if (hoursOverdue > 1) {
                console.log(`   🧹 Cleaning up stuck follow-up for contact ${followUp.contact_id} (${hoursOverdue.toFixed(1)} hours overdue)`);
                
                try {
                    await sendNonFatalSlackNotification(
                        'Manual Cleanup: Stuck FollowUp Removed',
                        `Manually removed stuck follow-up for contact ${followUp.contact_id} that was ${hoursOverdue.toFixed(1)} hours overdue`,
                        {
                            contactId: followUp.contact_id,
                            originalScheduledTime: followUp.follow_up_at_utc,
                            service: followUp.service,
                            province: followUp.province,
                            hoursOverdue: hoursOverdue.toFixed(1),
                            reason: 'Manual cleanup via utility script'
                        }
                    );
                } catch (slackError) {
                    console.warn('   ⚠️  Failed to send Slack notification, but continuing cleanup');
                }
                
                await run(db, 'DELETE FROM follow_ups WHERE follow_up_id = ?', [followUp.follow_up_id]);
                cleanedUp++;
                console.log(`   ✅ Deleted follow-up ${followUp.follow_up_id}`);
            } else {
                console.log(`   ⏰ Keeping recent follow-up (only ${hoursOverdue.toFixed(1)} hours overdue)`);
            }
        }
        
        if (cleanedUp > 0) {
            console.log(`\n🎉 Successfully cleaned up ${cleanedUp} stuck follow-up(s)!`);
        } else {
            console.log('\n✅ No stuck follow-ups needed cleanup (all are recent)');
        }
        
    } catch (error) {
        console.error('❌ Error during cleanup:', error);
    } finally {
        if (db) await closeDb(db);
    }
}

// Check command line arguments
const args = process.argv.slice(2);
const specificContactId = args[0];

if (specificContactId) {
    console.log(`🎯 Running cleanup for specific contact: ${specificContactId}`);
} else {
    console.log('🔍 Running cleanup for all stuck follow-ups');
    console.log('💡 Tip: You can specify a contact ID as an argument to focus on a specific contact');
}

cleanupStuckFollowUps(specificContactId)
    .then(() => {
        console.log('\n✨ Cleanup completed!');
        process.exit(0);
    })
    .catch((error) => {
        console.error('\n💥 Cleanup failed:', error);
        process.exit(1);
    }); 