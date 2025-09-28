const { BlobServiceClient, StorageSharedKeyCredential } = require('@azure/storage-blob');
const { v4: uuidv4 } = require('uuid');

class AzureStorageService {
    constructor() {
        this.accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
        this.accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;
        this.connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;

        // Initialize BlobServiceClient
        if (this.connectionString) {
            this.blobServiceClient = BlobServiceClient.fromConnectionString(this.connectionString);
        } else if (this.accountName && this.accountKey) {
            const credential = new StorageSharedKeyCredential(this.accountName, this.accountKey);
            this.blobServiceClient = new BlobServiceClient(`https://${this.accountName}.blob.core.windows.net`, credential);
        } else {
            throw new Error('Azure Storage credentials not provided');
        }

        // Container names
        this.containers = {
            profilePictures: 'profile-pictures',
            bookCovers: 'book-covers',
            bookContent: 'book-content',
            bookSamples: 'book-samples'
        };
    }

    /**
     * Upload file to specified container
     * @param {string} containerName - Name of the container
     * @param {Buffer} fileBuffer - File buffer
     * @param {string} fileName - Original filename
     * @param {string} mimeType - MIME type of the file
     * @param {Object} options - Additional options like isPublic
     * @returns {Promise<string>} - Returns the blob URL
     */
    async uploadFile(containerName, fileBuffer, fileName, mimeType, options = {}) {
        try {
            // Generate unique filename
            const fileExtension = fileName.split('.').pop();
            const uniqueFileName = `${Date.now()}-${uuidv4().substring(0, 8)}.${fileExtension}`;

            // Get container client
            const containerClient = this.blobServiceClient.getContainerClient(containerName);

            // Get block blob client
            const blockBlobClient = containerClient.getBlockBlobClient(uniqueFileName);

            // Upload options
            const uploadOptions = {
                blobHTTPHeaders: {
                    blobContentType: mimeType
                }
            };

            // Upload the file
            await blockBlobClient.upload(fileBuffer, fileBuffer.length, uploadOptions);

            // Return the blob URL
            return blockBlobClient.url;
        } catch (error) {
            console.error('Error uploading file to Azure Blob Storage:', error);
            throw error;
        }
    }

    /**
     * Delete file from container
     * @param {string} blobUrl - Complete blob URL
     * @returns {Promise<boolean>} - Returns true if deleted successfully
     */
    async deleteFile(blobUrl) {
        try {
            // Extract container name and blob name from URL
            const url = new URL(blobUrl);
            const pathParts = url.pathname.split('/').filter(part => part);
            const containerName = pathParts[0];
            const blobName = pathParts.slice(1).join('/');

            const containerClient = this.blobServiceClient.getContainerClient(containerName);
            const blockBlobClient = containerClient.getBlockBlobClient(blobName);

            await blockBlobClient.deleteIfExists();
            return true;
        } catch (error) {
            console.error('Error deleting file from Azure Blob Storage:', error);
            return false;
        }
    }

    /**
     * Generate SAS URL for private content (for rental access)
     * @param {string} blobUrl - Complete blob URL
     * @param {number} expiryHours - Hours until expiry (default: 1 hour)
     * @returns {Promise<string>} - Returns SAS URL
     */
    async generateSasUrl(blobUrl, expiryHours = 1) {
        try {
            // This is a placeholder for SAS URL generation
            // In production, implement proper SAS token generation
            // For now, return the original URL (only for development)
            console.log('SAS URL generation - Development mode');
            return blobUrl;
        } catch (error) {
            console.error('Error generating SAS URL:', error);
            throw error;
        }
    }

    /**
     * Upload profile picture
     * @param {Buffer} fileBuffer - File buffer
     * @param {string} fileName - Original filename
     * @param {string} mimeType - MIME type
     * @returns {Promise<string>} - Returns blob URL
     */
    async uploadProfilePicture(fileBuffer, fileName, mimeType) {
        return this.uploadFile(this.containers.profilePictures, fileBuffer, fileName, mimeType, { isPublic: true });
    }

    /**
     * Upload book cover
     * @param {Buffer} fileBuffer - File buffer
     * @param {string} fileName - Original filename
     * @param {string} mimeType - MIME type
     * @returns {Promise<string>} - Returns blob URL
     */
    async uploadBookCover(fileBuffer, fileName, mimeType) {
        return this.uploadFile(this.containers.bookCovers, fileBuffer, fileName, mimeType, { isPublic: true });
    }

    /**
     * Upload book content (private)
     * @param {Buffer} fileBuffer - File buffer
     * @param {string} fileName - Original filename
     * @param {string} mimeType - MIME type
     * @returns {Promise<string>} - Returns blob URL
     */
    async uploadBookContent(fileBuffer, fileName, mimeType) {
        return this.uploadFile(this.containers.bookContent, fileBuffer, fileName, mimeType, { isPublic: false });
    }

    /**
     * Upload book sample (public)
     * @param {Buffer} fileBuffer - File buffer
     * @param {string} fileName - Original filename
     * @param {string} mimeType - MIME type
     * @returns {Promise<string>} - Returns blob URL
     */
    async uploadBookSample(fileBuffer, fileName, mimeType) {
        return this.uploadFile(this.containers.bookSamples, fileBuffer, fileName, mimeType, { isPublic: true });
    }
}

// Create singleton instance
const azureStorageService = new AzureStorageService();

module.exports = azureStorageService;