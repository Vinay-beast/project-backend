/**
 * Migration Script: Move existing profile pictures from local storage to Azure Blob Storage
 * 
 * This script will:
 * 1. Find all users with local profile pictures (URLs starting with /uploads/profiles/)
 * 2. Upload those files to Azure Blob Storage
 * 3. Update the database with new Azure URLs
 * 4. Optionally clean up local files
 * 
 * Run this after setting up Azure Storage credentials
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../config/database');
const azureStorageService = require('../config/azureStorage');

async function migrateProfilePictures() {
    console.log('🚀 Starting profile picture migration to Azure Blob Storage...\n');

    try {
        // Get all users with local profile pictures
        const [users] = await pool.query(
            "SELECT id, name, profile_pic FROM users WHERE profile_pic LIKE '/uploads/profiles/%'"
        );

        if (users.length === 0) {
            console.log('✅ No local profile pictures found to migrate.');
            return;
        }

        console.log(`📋 Found ${users.length} profile pictures to migrate:\n`);

        const uploadDir = path.join(__dirname, '..', 'uploads', 'profiles');
        let successCount = 0;
        let errorCount = 0;
        const errors = [];

        for (const user of users) {
            try {
                console.log(`📤 Migrating: ${user.name} (ID: ${user.id})`);
                console.log(`   Current URL: ${user.profile_pic}`);

                // Extract filename from URL
                const filename = path.basename(user.profile_pic);
                const filePath = path.join(uploadDir, filename);

                // Check if file exists
                if (!fs.existsSync(filePath)) {
                    console.log(`   ⚠️  File not found on disk: ${filename}`);
                    errors.push(`User ${user.id}: File not found - ${filename}`);
                    errorCount++;
                    continue;
                }

                // Read file
                const fileBuffer = fs.readFileSync(filePath);
                const stats = fs.statSync(filePath);

                // Determine MIME type from extension
                const ext = path.extname(filename).toLowerCase();
                let mimeType = 'image/jpeg'; // default
                if (ext === '.png') mimeType = 'image/png';
                else if (ext === '.webp') mimeType = 'image/webp';
                else if (ext === '.gif') mimeType = 'image/gif';

                console.log(`   📏 File size: ${(stats.size / 1024).toFixed(1)} KB`);
                console.log(`   🔍 MIME type: ${mimeType}`);

                // Upload to Azure
                const azureUrl = await azureStorageService.uploadProfilePicture(
                    fileBuffer,
                    `migrated_${filename}`,
                    mimeType
                );

                console.log(`   ✅ Uploaded to Azure: ${azureUrl}`);

                // Update database
                await pool.query(
                    'UPDATE users SET profile_pic = ? WHERE id = ?',
                    [azureUrl, user.id]
                );

                console.log(`   💾 Database updated for user ${user.id}`);
                console.log(`   ----`);

                successCount++;

            } catch (error) {
                console.log(`   ❌ Error migrating user ${user.id}: ${error.message}`);
                errors.push(`User ${user.id}: ${error.message}`);
                errorCount++;
            }
        }

        // Summary
        console.log(`\n📊 Migration Summary:`);
        console.log(`   ✅ Successfully migrated: ${successCount}`);
        console.log(`   ❌ Failed: ${errorCount}`);

        if (errors.length > 0) {
            console.log(`\n❌ Errors encountered:`);
            errors.forEach(error => console.log(`   - ${error}`));
        }

        if (successCount > 0) {
            console.log(`\n🗑️  Local file cleanup:`);
            console.log(`   To remove old local files after verifying the migration, run:`);
            console.log(`   rm -rf "${uploadDir}"`);
            console.log(`   Or on Windows:`);
            console.log(`   rmdir /s "${uploadDir}"`);
        }

        console.log(`\n✨ Migration completed!`);

    } catch (error) {
        console.error('💥 Migration failed:', error);
        throw error;
    }
}

// Run migration if called directly
if (require.main === module) {
    migrateProfilePictures()
        .then(() => {
            console.log('\n🎉 All done! Your profile pictures are now stored in Azure Blob Storage.');
            process.exit(0);
        })
        .catch((error) => {
            console.error('\n💥 Migration failed:', error);
            process.exit(1);
        });
}

module.exports = { migrateProfilePictures };