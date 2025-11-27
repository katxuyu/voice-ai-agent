import { addSalesRep, initializeDatabase, getAllSalesReps, openDb, run, closeDb } from './db.js';

// Helper function to update an existing sales rep
async function updateSalesRep(ghlUserId, name, services, provinces) {
    let db;
    try {
        db = await openDb();
        const result = await run(db,
            `UPDATE sales_reps 
             SET name = ?, services = ?, provinces = ?, updated_at = CURRENT_TIMESTAMP 
             WHERE ghl_user_id = ?`,
            [name, JSON.stringify(services), JSON.stringify(provinces), ghlUserId]
        );
        console.log(`[DB] Updated sales rep ${name} (${ghlUserId})`);
        return result.changes > 0;
    } catch (error) {
        console.error('[DB] Error updating sales rep:', error);
        throw error;
    } finally {
        if (db) await closeDb(db);
    }
}

// Helper function to delete a sales rep by database ID
async function deleteSalesRep(repId) {
    let db;
    try {
        db = await openDb();
        const result = await run(db,
            `DELETE FROM sales_reps WHERE rep_id = ?`,
            [repId]
        );
        console.log(`[DB] Deleted sales rep with ID: ${repId}`);
        return result.changes > 0;
    } catch (error) {
        console.error('[DB] Error deleting sales rep:', error);
        throw error;
    } finally {
        if (db) await closeDb(db);
    }
}

// Function to detect and remove duplicates
async function detectAndRemoveDuplicates() {
    console.log('🔍 Checking for duplicates...');
    const allReps = await getAllSalesReps();
    
    if (allReps.length === 0) {
        console.log('   No sales reps found - nothing to check.');
        return;
    }
    
    // Check for duplicate GHL IDs (shouldn't happen due to UNIQUE constraint, but let's be safe)
    const ghlIdGroups = new Map();
    allReps.forEach(rep => {
        if (!ghlIdGroups.has(rep.ghlUserId)) {
            ghlIdGroups.set(rep.ghlUserId, []);
        }
        ghlIdGroups.get(rep.ghlUserId).push(rep);
    });
    
    // Check for duplicate names (potential same person with different GHL IDs)
    const nameGroups = new Map();
    allReps.forEach(rep => {
        const normalizedName = rep.name.trim().toUpperCase();
        if (!nameGroups.has(normalizedName)) {
            nameGroups.set(normalizedName, []);
        }
        nameGroups.get(normalizedName).push(rep);
    });
    
    let duplicatesFound = false;
    let deletedCount = 0;
    
    // Handle GHL ID duplicates (keep the most recent one)
    for (const [ghlUserId, reps] of ghlIdGroups) {
        if (reps.length > 1) {
            duplicatesFound = true;
            console.log(`\n❌ Found ${reps.length} reps with same GHL ID: ${ghlUserId}`);
            
            // Sort by creation date (most recent first) and keep the first one
            const sortedReps = reps.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            const keepRep = sortedReps[0];
            const deleteReps = sortedReps.slice(1);
            
            console.log(`   ✅ Keeping: ${keepRep.name} (ID: ${keepRep.repId}, Created: ${keepRep.createdAt})`);
            
            for (const deleteRep of deleteReps) {
                console.log(`   🗑️  Deleting: ${deleteRep.name} (ID: ${deleteRep.repId}, Created: ${deleteRep.createdAt})`);
                await deleteSalesRep(deleteRep.repId);
                deletedCount++;
            }
        }
    }
    
    // Handle name duplicates (warn but don't auto-delete - these might be legitimate)
    for (const [name, reps] of nameGroups) {
        if (reps.length > 1) {
            duplicatesFound = true;
            console.log(`\n⚠️  Found ${reps.length} reps with same name: ${name}`);
            reps.forEach(rep => {
                console.log(`   - GHL ID: ${rep.ghlUserId}, DB ID: ${rep.repId}, Created: ${rep.createdAt}`);
                console.log(`     Services: ${rep.services.join(', ')}`);
                console.log(`     Provinces: ${rep.provinces.join(', ')}`);
            });
            console.log(`   👆 Please review manually - these might be the same person with different GHL accounts`);
        }
    }
    
    if (!duplicatesFound) {
        console.log('   ✅ No duplicates found - database is clean!');
    } else {
        if (deletedCount > 0) {
            console.log(`\n🧹 Cleanup complete: Removed ${deletedCount} duplicate records`);
        }
        console.log('   💡 Re-run this script to process with clean data');
    }
    
    return duplicatesFound;
}

// Helper function to check if two arrays are equal (order independent)
function arraysEqual(arr1, arr2) {
    if (arr1.length !== arr2.length) return false;
    const sorted1 = [...arr1].sort();
    const sorted2 = [...arr2].sort();
    return sorted1.every((val, index) => val === sorted2[index]);
}

// Helper function to check if sales rep data needs updating
function needsUpdate(existing, newData) {
    return existing.name !== newData.name ||
           !arraysEqual(existing.services, newData.services) ||
           !arraysEqual(existing.provinces, newData.provinces);
}

async function manageSalesReps() {
    console.log('Initializing database...');
    await initializeDatabase();
    
    // First, check for and remove duplicates
    const hasDuplicates = await detectAndRemoveDuplicates();
    
    if (hasDuplicates) {
        console.log('\n🔄 Duplicates were found. Getting fresh data after cleanup...');
    }
    
    console.log('\nGetting existing sales representatives...');
    const existingReps = await getAllSalesReps();
    
    // Create a map of existing reps by GHL ID for quick lookup
    const existingRepsMap = new Map();
    existingReps.forEach(rep => {
        existingRepsMap.set(rep.ghlUserId, rep);
    });
    
    console.log(`Found ${existingReps.length} existing sales representatives.`);
    
    // Define the sales reps we want to have in the system
    const desiredReps = [
        {
            ghlUserId: 'RPJeYVZLML8grEX4sBpQ',
            name: 'ALBERTO ABOZZI',
            services: ['Infissi', 'Vetrate', 'Pergole'],
            provinces: ['CA', 'NU', 'OR', 'SS', 'SU']
        },
        {
            ghlUserId: '7hsuzrgWX6CcpkY6wX39',
            name: 'ALFIO CAMPAGNA',
            services: ['Infissi', 'Vetrate', 'Pergole'],
            provinces: ['BI', 'VC', 'CN', 'NO', 'TO', 'AT']
        },
        {
            ghlUserId: 'ploLrwhsJ8jfWdql3KtB',
            name: 'ANDREA CANCELLIERI',
            services: ['Infissi', 'Vetrate', 'Pergole'],
            provinces: ['RN', 'FC', 'BO', 'MO', 'PU']
        },
        {
            ghlUserId: 'aQXv4wHVaVJvVPOm0JPi',
            name: 'LUCA FALLENI',
            services: ['Infissi', 'Vetrate', 'Pergole'],
            provinces: ['LI', 'PI', 'LU']
        },
        {
            ghlUserId: '5ePYxbuKqetKguMjLGmq',
            name: 'MATTEO BEVILACQUA',
            services: ['Infissi', 'Vetrate', 'Pergole'],
            provinces: ['AN']
        },
        {
            ghlUserId: '9ZRIQQ5iVIs2j9ucJsB1',
            name: 'MARCO PINZAUTI',
            services: ['Infissi', 'Vetrate', 'Pergole'],
            provinces: ['FI']
        },
        {
            ghlUserId: 'Bbz02sdAfJP3oP9vkX4k',
            name: 'MAURIZIO PRIOLO',
            services: ['Infissi', 'Vetrate', 'Pergole'],
            provinces: ['PD', 'VR', 'VI', 'TV', 'MN']
        },
        {
            ghlUserId: 'tr2Ti8iYFz4mXjPmXaSk',
            name: 'GIANLUCA MARRONI',
            services: ['Infissi', 'Vetrate', 'Pergole'],
            provinces: ['RM']
        },
        {
            ghlUserId: 'sA4fG7hJ0kL3mN6pQ9rT',
            name: 'SALVATORE ALFIERI',
            services: ['Infissi', 'Vetrate', 'Pergole'],
            provinces: ['PG', 'TR', 'FI', 'AR', 'SI']
        },
        {
            ghlUserId: 'sF2bE5gH8jK1mN4pQ7rT',
            name: 'STEFANO FRACARO',
            services: ['Infissi', 'Vetrate', 'Pergole'],
            provinces: ['BL', 'PD', 'RO', 'TV', 'VE', 'VR', 'VI']
        },
        {
            ghlUserId: 'yOGmz1pmteWCktnkuptx',
            name: 'ALESSIO BANCHI',
            services: ['Infissi', 'Vetrate', 'Pergole'],
            provinces: ['FI', 'PT', 'PO', 'SI', 'AR']
        },
        {
            ghlUserId: '8uFYEk4gD3reIndk1c14',
            name: 'MANUEL MILONE',
            services: ['Infissi', 'Vetrate', 'Pergole'],
            provinces: ['MI', 'MB', 'VA', 'CO', 'LC', 'CR', 'LO', 'BG', 'BS']
        },
        {
            ghlUserId: 'Ra8BfOopSOwJUCZpmcFN',
            name: 'GIANLUCA SCURTI',
            services: ['Infissi', 'Vetrate', 'Pergole'],
            provinces: ['PE', 'CH', 'TE']
        }
    ];
    
    try {
        let addedCount = 0;
        let updatedCount = 0;
        let skippedCount = 0;
        
        console.log('\nProcessing sales representatives...');
        
        for (const desiredRep of desiredReps) {
            const existingRep = existingRepsMap.get(desiredRep.ghlUserId);
            
            if (!existingRep) {
                // Rep doesn't exist, add them
                await addSalesRep(
                    desiredRep.ghlUserId,
                    desiredRep.name,
                    desiredRep.services,
                    desiredRep.provinces
                );
                console.log(`➕ Added: ${desiredRep.name}`);
                addedCount++;
            } else if (needsUpdate(existingRep, desiredRep)) {
                // Rep exists but needs updating
                await updateSalesRep(
                    desiredRep.ghlUserId,
                    desiredRep.name,
                    desiredRep.services,
                    desiredRep.provinces
                );
                console.log(`🔄 Updated: ${desiredRep.name}`);
                updatedCount++;
            } else {
                // Rep exists and is up to date
                console.log(`✅ Unchanged: ${desiredRep.name}`);
                skippedCount++;
            }
        }
        
        console.log('\n📊 Summary:');
        console.log(`➕ Added: ${addedCount} representatives`);
        console.log(`🔄 Updated: ${updatedCount} representatives`);
        console.log(`✅ Unchanged: ${skippedCount} representatives`);
        console.log(`📝 Total processed: ${desiredReps.length} representatives`);
        
        // Check for any existing reps that aren't in our desired list
        const desiredGhlIds = new Set(desiredReps.map(rep => rep.ghlUserId));
        const extraReps = existingReps.filter(rep => !desiredGhlIds.has(rep.ghlUserId));
        
        if (extraReps.length > 0) {
            console.log('\n⚠️  Found representatives in database not in current list:');
            extraReps.forEach(rep => {
                console.log(`   - ${rep.name} (${rep.ghlUserId})`);
            });
            console.log('   These were left unchanged. Remove manually if no longer needed.');
        }
        
        console.log('\n✅ Sales representatives management completed successfully!');
        
    } catch (error) {
        console.error('❌ Error managing sales representatives:', error);
    }
}

// Run the script
manageSalesReps().catch(console.error); 