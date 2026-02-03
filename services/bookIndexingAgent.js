// ============================================
// BOOK INDEXING AGENT
// Background service to index PDF books
// Uses: Azure Blob Storage + Azure Document Intelligence + Azure Cognitive Search
// ============================================

const { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } = require('@azure/storage-blob');
const { SearchClient, SearchIndexClient, AzureKeyCredential } = require('@azure/search-documents');
const { DocumentAnalysisClient } = require('@azure/ai-form-recognizer');
const pool = require('../config/database');

class BookIndexingAgent {
    constructor() {
        // Azure Blob Storage
        this.blobServiceClient = BlobServiceClient.fromConnectionString(
            process.env.AZURE_STORAGE_CONNECTION_STRING
        );
        this.bookContainer = 'book-content';

        // Parse storage account credentials for SAS token generation
        const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING || '';
        const accountNameMatch = connStr.match(/AccountName=([^;]+)/);
        const accountKeyMatch = connStr.match(/AccountKey=([^;]+)/);
        this.storageAccountName = accountNameMatch ? accountNameMatch[1] : '';
        this.storageAccountKey = accountKeyMatch ? accountKeyMatch[1] : '';

        // Azure Document Intelligence (OCR)
        this.documentClient = new DocumentAnalysisClient(
            process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT,
            new AzureKeyCredential(process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY)
        );

        // Azure Cognitive Search
        this.searchEndpoint = process.env.AZURE_SEARCH_ENDPOINT;
        this.searchKey = process.env.AZURE_SEARCH_KEY;
        this.indexName = 'book-pages-index';

        this.searchIndexClient = new SearchIndexClient(
            this.searchEndpoint,
            new AzureKeyCredential(this.searchKey)
        );

        this.searchClient = new SearchClient(
            this.searchEndpoint,
            this.indexName,
            new AzureKeyCredential(this.searchKey)
        );

        console.log('📚 Book Indexing Agent initialized');
    }

    // ========================================
    // AGENT 1: LIST AGENT - Lists all PDFs/Book files
    // ========================================
    async listPDFsFromBlob() {
        console.log('\n🔍 LIST AGENT: Scanning Azure Blob Storage for book files...');

        const containerClient = this.blobServiceClient.getContainerClient(this.bookContainer);
        const pdfs = [];

        try {
            for await (const blob of containerClient.listBlobsFlat()) {
                // Check if it's a PDF by extension OR content type
                const isPdf = blob.name.toLowerCase().endsWith('.pdf') ||
                    blob.properties.contentType === 'application/pdf';

                // Also include files without extension (likely book uploads)
                const hasNoExtension = !blob.name.includes('.') || blob.name.split('.').pop().length > 5;

                if (isPdf || hasNoExtension) {
                    // Generate SAS token for this blob (valid for 1 hour)
                    const sasUrl = await this.generateBlobSasUrl(blob.name);

                    pdfs.push({
                        name: blob.name,
                        url: sasUrl, // Use SAS URL instead of plain URL
                        size: blob.properties.contentLength,
                        lastModified: blob.properties.lastModified,
                        contentType: blob.properties.contentType
                    });
                    console.log(`   📄 Found: ${blob.name} (${blob.properties.contentType || 'unknown type'})`);
                }
            }
        } catch (error) {
            console.error('   ❌ Error listing PDFs:', error.message);
        }

        console.log(`   ✅ Found ${pdfs.length} book files`);
        return pdfs;
    }

    // Generate SAS URL for a blob (allows Document Intelligence to access private blobs)
    async generateBlobSasUrl(blobName) {
        try {
            const containerClient = this.blobServiceClient.getContainerClient(this.bookContainer);
            const blobClient = containerClient.getBlobClient(blobName);

            // Create shared key credential
            const sharedKeyCredential = new StorageSharedKeyCredential(
                this.storageAccountName,
                this.storageAccountKey
            );

            // Generate SAS token valid for 1 hour
            const expiresOn = new Date();
            expiresOn.setHours(expiresOn.getHours() + 1);

            const sasToken = generateBlobSASQueryParameters({
                containerName: this.bookContainer,
                blobName: blobName,
                permissions: BlobSASPermissions.parse('r'), // Read only
                expiresOn: expiresOn
            }, sharedKeyCredential).toString();

            return `${blobClient.url}?${sasToken}`;
        } catch (error) {
            console.error(`   ⚠️ Could not generate SAS for ${blobName}:`, error.message);
            // Fallback to plain URL
            const containerClient = this.blobServiceClient.getContainerClient(this.bookContainer);
            return `${containerClient.url}/${blobName}`;
        }
    }

    // ========================================
    // AGENT 2: OCR AGENT - Extracts text from PDF
    // ========================================
    async extractTextFromPDF(pdfUrl, bookName) {
        console.log(`\n🖼️ OCR AGENT: Extracting text from "${bookName}"...`);
        console.log(`   📎 URL: ${pdfUrl.substring(0, 100)}...`);

        try {
            // Start the analysis
            console.log(`   ⏳ Starting Document Intelligence analysis...`);
            const poller = await this.documentClient.beginAnalyzeDocumentFromUrl(
                'prebuilt-read',
                pdfUrl
            );

            console.log(`   ⏳ Waiting for OCR to complete (this may take a few minutes for large PDFs)...`);
            // Wait for completion
            const result = await poller.pollUntilDone();

            console.log(`   📄 Analysis complete. Found ${result.pages?.length || 0} pages.`);

            const pages = [];
            let pageNumber = 1;

            for (const page of result.pages || []) {
                let pageText = '';

                // Extract text from lines
                for (const line of page.lines || []) {
                    pageText += line.content + '\n';
                }

                if (pageText.trim()) {
                    pages.push({
                        pageNumber,
                        text: pageText.trim(),
                        wordCount: pageText.split(/\s+/).length
                    });
                }
                pageNumber++;
            }

            console.log(`   ✅ Extracted ${pages.length} pages with text from "${bookName}"`);
            return pages;

        } catch (error) {
            console.error(`   ❌ OCR Error for "${bookName}":`);
            console.error(`      Error Type: ${error.name}`);
            console.error(`      Error Message: ${error.message}`);
            console.error(`      Error Code: ${error.code || 'N/A'}`);
            if (error.details) {
                console.error(`      Details: ${JSON.stringify(error.details)}`);
            }
            return [];
        }
    }

    // ========================================
    // AGENT 3: CHUNK AGENT - Splits text into chunks
    // ========================================
    chunkText(pages, bookName, chunkSize = 400) {
        console.log(`\n📦 CHUNK AGENT: Splitting "${bookName}" into searchable chunks...`);

        const chunks = [];
        let chunkId = 1;

        for (const page of pages) {
            const words = page.text.split(/\s+/);

            // Create chunks of ~400 words with overlap
            for (let i = 0; i < words.length; i += chunkSize - 50) {
                const chunkWords = words.slice(i, i + chunkSize);
                const chunkText = chunkWords.join(' ');

                if (chunkText.length > 50) { // Skip very small chunks
                    chunks.push({
                        id: `${this.sanitizeId(bookName)}-p${page.pageNumber}-c${chunkId}`,
                        bookName: bookName,
                        pageNumber: page.pageNumber,
                        chunkIndex: chunkId,
                        content: chunkText,
                        wordCount: chunkWords.length,
                        // Extract some keywords (first 10 unique words > 4 chars)
                        keywords: [...new Set(
                            chunkWords
                                .filter(w => w.length > 4)
                                .map(w => w.toLowerCase().replace(/[^a-z]/g, ''))
                                .filter(w => w.length > 4)
                        )].slice(0, 20).join(', ')
                    });
                    chunkId++;
                }
            }
        }

        console.log(`   ✅ Created ${chunks.length} chunks from "${bookName}"`);
        return chunks;
    }

    // Helper to sanitize IDs for Azure Search
    sanitizeId(str) {
        return str
            .replace(/[^a-zA-Z0-9-_]/g, '-')
            .replace(/-+/g, '-')
            .substring(0, 50);
    }

    // Get book name from database using filename pattern
    async getBookNameFromFilename(filename) {
        try {
            // Pattern: book_123_content.pdf -> extract bookId = 123
            const match = filename.match(/book[_-]?(\d+)[_-]?content/i);
            if (match) {
                const bookId = match[1];
                const [rows] = await pool.query('SELECT title, author FROM books WHERE id = ?', [bookId]);
                if (rows.length > 0) {
                    const book = rows[0];
                    console.log(`   📚 Found in DB: "${book.title}" by ${book.author}`);
                    return `${book.title} by ${book.author}`;
                }
            }

            // Try to find by content_url containing the filename
            const [urlRows] = await pool.query(
                'SELECT title, author FROM books WHERE content_url LIKE ?',
                [`%${filename}%`]
            );
            if (urlRows.length > 0) {
                const book = urlRows[0];
                console.log(`   📚 Found by URL: "${book.title}" by ${book.author}`);
                return `${book.title} by ${book.author}`;
            }

            return null;
        } catch (error) {
            console.error('   ⚠️ Database lookup failed:', error.message);
            return null;
        }
    }

    // ========================================
    // AGENT 4: INDEX AGENT - Creates/updates search index
    // ========================================
    async createSearchIndex() {
        console.log('\n🗂️ INDEX AGENT: Creating Azure Cognitive Search index...');

        const indexSchema = {
            name: this.indexName,
            fields: [
                { name: 'id', type: 'Edm.String', key: true, searchable: false },
                { name: 'bookName', type: 'Edm.String', searchable: true, filterable: true, facetable: true },
                { name: 'pageNumber', type: 'Edm.Int32', filterable: true, sortable: true },
                { name: 'chunkIndex', type: 'Edm.Int32', filterable: true },
                { name: 'content', type: 'Edm.String', searchable: true, analyzer: 'en.microsoft' },
                { name: 'wordCount', type: 'Edm.Int32', filterable: true },
                { name: 'keywords', type: 'Edm.String', searchable: true }
            ]
        };

        try {
            // Delete existing index if it exists
            try {
                await this.searchIndexClient.deleteIndex(this.indexName);
                console.log('   🗑️ Deleted existing index');
            } catch (e) {
                // Index doesn't exist, that's fine
            }

            // Create new index
            await this.searchIndexClient.createIndex(indexSchema);
            console.log('   ✅ Search index created successfully');
            return true;

        } catch (error) {
            console.error('   ❌ Error creating index:', error.message);
            return false;
        }
    }

    // ========================================
    // AGENT 4 (continued): Push chunks to index
    // ========================================
    async pushToSearchIndex(chunks) {
        console.log(`\n📤 INDEX AGENT: Pushing ${chunks.length} chunks to Azure Search...`);

        try {
            // Upload in batches of 100
            const batchSize = 100;
            for (let i = 0; i < chunks.length; i += batchSize) {
                const batch = chunks.slice(i, i + batchSize);
                await this.searchClient.uploadDocuments(batch);
                console.log(`   📦 Uploaded batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(chunks.length / batchSize)}`);
            }

            console.log(`   ✅ Successfully indexed ${chunks.length} chunks`);
            return true;

        } catch (error) {
            console.error('   ❌ Error pushing to index:', error.message);
            return false;
        }
    }

    // ========================================
    // MAIN: Run full indexing pipeline
    // ========================================
    async runIndexingPipeline() {
        console.log('\n' + '═'.repeat(60));
        console.log('🚀 BOOK INDEXING PIPELINE STARTED');
        console.log('═'.repeat(60));

        const startTime = Date.now();
        const results = {
            success: false,
            booksProcessed: 0,
            chunksCreated: 0,
            errors: []
        };

        try {
            // Step 1: Create search index
            const indexCreated = await this.createSearchIndex();
            if (!indexCreated) {
                throw new Error('Failed to create search index');
            }

            // Step 2: List all PDFs
            const pdfs = await this.listPDFsFromBlob();
            if (pdfs.length === 0) {
                console.log('   ⚠️ No PDFs found in blob storage');
                results.success = true;
                results.message = 'No PDFs found to index';
                return results;
            }

            // Step 3: Process each PDF
            const allChunks = [];

            for (const pdf of pdfs) {
                // Try to get book name from database using bookId in filename
                let bookName = await this.getBookNameFromFilename(pdf.name);
                if (!bookName) {
                    // Fallback: clean up filename
                    bookName = pdf.name.replace('.pdf', '').replace(/[-_]/g, ' ').replace(/book \d+ content/i, '').trim();
                    if (!bookName || bookName.match(/^\d+\s*[a-f0-9]+$/i)) {
                        // If still looks like a random ID, use a generic name with timestamp
                        bookName = `Book uploaded ${new Date(pdf.lastModified).toLocaleDateString()}`;
                    }
                }

                console.log(`\n${'─'.repeat(50)}`);
                console.log(`📖 Processing: ${bookName}`);
                console.log(`   📁 File: ${pdf.name}`);
                console.log('─'.repeat(50));

                // Extract text using OCR
                const pages = await this.extractTextFromPDF(pdf.url, bookName);

                if (pages.length > 0) {
                    // Create chunks
                    const chunks = this.chunkText(pages, bookName);
                    allChunks.push(...chunks);
                    results.booksProcessed++;
                } else {
                    results.errors.push(`No text extracted from ${bookName}`);
                }
            }

            // Step 4: Push all chunks to index
            if (allChunks.length > 0) {
                await this.pushToSearchIndex(allChunks);
                results.chunksCreated = allChunks.length;
            }

            results.success = true;

        } catch (error) {
            console.error('❌ Pipeline Error:', error);
            results.errors.push(error.message);
        }

        const endTime = Date.now();

        console.log('\n' + '═'.repeat(60));
        console.log('✅ INDEXING PIPELINE COMPLETE');
        console.log(`   ⏱️ Total time: ${Math.round((endTime - startTime) / 1000)}s`);
        console.log(`   📚 Books processed: ${results.booksProcessed}`);
        console.log(`   📦 Chunks created: ${results.chunksCreated}`);
        if (results.errors.length > 0) {
            console.log(`   ⚠️ Errors: ${results.errors.length}`);
        }
        console.log('═'.repeat(60) + '\n');

        return results;
    }

    // ========================================
    // INDEX SINGLE BOOK (for new uploads)
    // ========================================
    async indexSingleBook(pdfUrl, bookName) {
        console.log(`\n📖 Indexing single book: ${bookName}`);

        try {
            // Extract text
            const pages = await this.extractTextFromPDF(pdfUrl, bookName);

            if (pages.length === 0) {
                return { success: false, error: 'No text extracted from PDF' };
            }

            // Create chunks
            const chunks = this.chunkText(pages, bookName);

            // Push to index
            await this.pushToSearchIndex(chunks);

            return {
                success: true,
                pagesProcessed: pages.length,
                chunksCreated: chunks.length
            };

        } catch (error) {
            console.error('Error indexing book:', error);
            return { success: false, error: error.message };
        }
    }

    // ========================================
    // GET INDEX STATS
    // ========================================
    async getIndexStats() {
        try {
            const indexClient = new SearchIndexClient(
                this.searchEndpoint,
                new AzureKeyCredential(this.searchKey)
            );

            const index = await indexClient.getIndex(this.indexName);

            // Get document count
            const countResult = await this.searchClient.search('*', {
                top: 0,
                includeTotalCount: true
            });

            return {
                indexName: this.indexName,
                documentCount: countResult.count || 0,
                fields: index.fields.map(f => f.name)
            };

        } catch (error) {
            return {
                indexName: this.indexName,
                error: error.message
            };
        }
    }
}

module.exports = BookIndexingAgent;
