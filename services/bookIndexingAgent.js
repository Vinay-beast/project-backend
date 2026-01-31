// ============================================
// BOOK INDEXING AGENT
// Background service to index PDF books
// Uses: Azure Blob Storage + Azure Document Intelligence + Azure Cognitive Search
// ============================================

const { BlobServiceClient } = require('@azure/storage-blob');
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

    // Helper: Convert readable stream to buffer
    async streamToBuffer(readableStream) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            readableStream.on('data', (data) => chunks.push(data));
            readableStream.on('end', () => resolve(Buffer.concat(chunks)));
            readableStream.on('error', reject);
        });
    }

    // ========================================
    // AGENT 1: LIST AGENT - Lists all PDFs
    // ========================================
    async listPDFsFromBlob() {
        console.log('\n🔍 LIST AGENT: Scanning Azure Blob Storage for PDFs...');

        const containerClient = this.blobServiceClient.getContainerClient(this.bookContainer);
        const pdfs = [];

        try {
            for await (const blob of containerClient.listBlobsFlat()) {
                if (blob.name.toLowerCase().endsWith('.pdf')) {
                    pdfs.push({
                        name: blob.name,
                        url: `${containerClient.url}/${blob.name}`,
                        size: blob.properties.contentLength,
                        lastModified: blob.properties.lastModified
                    });
                    console.log(`   📄 Found: ${blob.name}`);
                }
            }
        } catch (error) {
            console.error('   ❌ Error listing PDFs:', error.message);
        }

        console.log(`   ✅ Found ${pdfs.length} PDF files`);
        return pdfs;
    }

    // ========================================
    // AGENT 2: OCR AGENT - Extracts text from PDF
    // Uses buffer-based analysis to avoid cross-region issues
    // ========================================
    async extractTextFromPDF(pdfUrl, bookName) {
        console.log(`\n🖼️ OCR AGENT: Extracting text from "${bookName}"...`);

        try {
            let pdfBuffer;

            // Check if we need to download from blob storage or use URL
            if (pdfUrl.includes('blob.core.windows.net')) {
                // Download from Azure Blob Storage first (fixes cross-region issues)
                console.log(`   📥 Downloading PDF from blob storage...`);

                const containerClient = this.blobServiceClient.getContainerClient(this.bookContainer);

                // Extract blob name from URL (handles both simple filename and full path)
                const urlParts = new URL(pdfUrl);
                const pathParts = urlParts.pathname.split('/').filter(p => p);
                // Remove container name from path to get blob name
                const blobName = pathParts.slice(1).join('/') || pathParts[pathParts.length - 1];

                console.log(`   📦 Blob name: ${blobName}`);

                const blobClient = containerClient.getBlobClient(blobName);
                const downloadResponse = await blobClient.download();
                pdfBuffer = await this.streamToBuffer(downloadResponse.readableStreamBody);

                console.log(`   ✅ Downloaded ${pdfBuffer.length} bytes`);
            } else {
                // For non-Azure URLs, try URL-based analysis
                console.log(`   🌐 Using URL-based analysis...`);
                const poller = await this.documentClient.beginAnalyzeDocumentFromUrl(
                    'prebuilt-read',
                    pdfUrl
                );
                const result = await poller.pollUntilDone();
                return this.extractPagesFromResult(result, bookName);
            }

            // Use buffer-based analysis (works across regions)
            console.log(`   🔍 Running Document Intelligence OCR...`);
            const poller = await this.documentClient.beginAnalyzeDocument(
                'prebuilt-read',
                pdfBuffer
            );

            // Wait for completion
            const result = await poller.pollUntilDone();
            return this.extractPagesFromResult(result, bookName);

        } catch (error) {
            console.error(`   ❌ OCR Error for "${bookName}":`, error.message);
            console.error(`   Details:`, error);
            return [];
        }
    }

    // Helper to extract pages from Document Intelligence result
    extractPagesFromResult(result, bookName) {
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

        console.log(`   ✅ Extracted ${pages.length} pages from "${bookName}"`);
        return pages;
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
                // Try to find the actual book title from database
                let bookName = pdf.name.replace('.pdf', '').replace(/-/g, ' ');

                try {
                    // The blob filename might contain the book ID or be part of the content_url
                    const [rows] = await pool.query(
                        `SELECT title FROM books WHERE content_url LIKE ? LIMIT 1`,
                        [`%${pdf.name}%`]
                    );
                    if (rows.length > 0) {
                        bookName = rows[0].title;
                        console.log(`   📖 Matched blob "${pdf.name}" to book "${bookName}"`);
                    } else {
                        console.log(`   ⚠️ No database match for blob "${pdf.name}", using filename`);
                    }
                } catch (dbError) {
                    console.log(`   ⚠️ Database lookup failed: ${dbError.message}`);
                }

                console.log(`\n${'─'.repeat(50)}`);
                console.log(`📖 Processing: ${bookName}`);
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
    // ENSURE INDEX EXISTS
    // ========================================
    async ensureIndexExists() {
        try {
            await this.searchIndexClient.getIndex(this.indexName);
            console.log(`   ✅ Index "${this.indexName}" exists`);
            return true;
        } catch (error) {
            if (error.statusCode === 404 || error.code === 'ResourceNotFound') {
                console.log(`   📝 Index "${this.indexName}" not found, creating...`);
                return await this.createSearchIndex();
            } else {
                console.error(`   ❌ Error checking index:`, error.message);
                throw error;
            }
        }
    }

    // ========================================
    // INDEX SINGLE BOOK (for new uploads)
    // ========================================
    async indexSingleBook(pdfUrl, bookName) {
        console.log(`\n📖 Indexing single book: ${bookName}`);
        console.log(`   PDF URL: ${pdfUrl}`);

        try {
            // Ensure search index exists first
            await this.ensureIndexExists();

            // Extract text using OCR
            const pages = await this.extractTextFromPDF(pdfUrl, bookName);

            if (pages.length === 0) {
                console.log(`   ⚠️ No text extracted from PDF`);
                return { success: false, error: 'No text extracted from PDF. The PDF may be image-only or corrupted.' };
            }

            console.log(`   📄 Extracted ${pages.length} pages`);

            // Create searchable chunks
            const chunks = this.chunkText(pages, bookName);
            console.log(`   📦 Created ${chunks.length} chunks`);

            // Push to search index
            await this.pushToSearchIndex(chunks);

            console.log(`   ✅ Book "${bookName}" indexed successfully!`);

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
