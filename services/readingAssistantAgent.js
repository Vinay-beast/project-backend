// ============================================
// SMART READING ASSISTANT - MULTI-AGENT SERVICE
// Generates book summaries and key insights
// Uses: Azure Cognitive Search + Groq AI
// ============================================

const { SearchClient, AzureKeyCredential } = require('@azure/search-documents');
const https = require('https');
const pool = require('../config/database');

class ReadingAssistantAgent {
    constructor() {
        // Azure Cognitive Search (for retrieving book content)
        this.searchClient = new SearchClient(
            process.env.AZURE_SEARCH_ENDPOINT,
            'book-pages-index',
            new AzureKeyCredential(process.env.AZURE_SEARCH_KEY)
        );

        // Groq API Config
        this.groqApiKey = process.env.GROQ_API_KEY;
        this.groqApiUrl = 'api.groq.com';
        this.groqModel = 'llama-3.3-70b-versatile';

        console.log('📚 Reading Assistant Agent initialized');
    }

    // ========================================
    // AGENT DEFINITIONS
    // ========================================

    static AGENTS = {
        CONTENT_RETRIEVER: {
            name: '📖 Content Retriever Agent',
            role: 'Retrieves book content from search index'
        },
        SUMMARY_GENERATOR: {
            name: '📝 Summary Generator Agent',
            role: 'Generates comprehensive book summaries',
            systemPrompt: `You are an expert book summarizer. Your job is to create clear, insightful summaries that capture the essence of a book.

Given the book content, create:
1. A comprehensive summary (2-3 paragraphs) that captures the main themes and ideas
2. The book's central argument or narrative
3. Who would benefit most from reading this book

Write in an engaging, accessible style. Be specific about what makes this book valuable.

RESPOND ONLY WITH VALID JSON:
{
    "summary": "...",
    "central_theme": "...",
    "target_audience": "...",
    "tone": "academic|casual|inspirational|practical"
}`
        },
        KEY_POINTS_EXTRACTOR: {
            name: '💡 Key Points Extractor Agent',
            role: 'Extracts key takeaways and insights',
            systemPrompt: `You are a Key Insights Extractor. Your job is to identify the most valuable takeaways from a book.

Given the book content, extract:
1. 5-7 key takeaways (actionable insights)
2. 3-5 memorable quotes or ideas
3. Main concepts or frameworks introduced
4. Practical applications

Each takeaway should be concise but meaningful.

RESPOND ONLY WITH VALID JSON:
{
    "key_takeaways": ["...", "..."],
    "memorable_ideas": ["...", "..."],
    "main_concepts": ["...", "..."],
    "practical_applications": ["...", "..."]
}`
        },
        METADATA_ANALYZER: {
            name: '📊 Metadata Analyzer Agent',
            role: 'Analyzes reading difficulty and time',
            systemPrompt: `You are a Reading Metadata Analyzer. Analyze the book content to determine:

1. difficulty_level: "beginner", "intermediate", or "advanced"
2. estimated_reading_hours: number (based on content complexity and length)
3. prerequisites: concepts or knowledge helpful before reading
4. genre_tags: relevant categories/tags

Consider vocabulary complexity, concept depth, and assumed prior knowledge.

RESPOND ONLY WITH VALID JSON:
{
    "difficulty_level": "beginner|intermediate|advanced",
    "estimated_reading_hours": 5,
    "prerequisites": ["...", "..."],
    "genre_tags": ["...", "..."]
}`
        }
    };

    // ========================================
    // GROQ API HELPER
    // ========================================

    async callGroqAgent(agentType, content, maxTokens = 1024) {
        const agent = ReadingAssistantAgent.AGENTS[agentType];

        console.log(`\n${'─'.repeat(50)}`);
        console.log(`${agent.name} starting...`);

        return new Promise((resolve, reject) => {
            const requestBody = JSON.stringify({
                model: this.groqModel,
                messages: [
                    { role: 'system', content: agent.systemPrompt },
                    { role: 'user', content: content }
                ],
                temperature: 0.3,
                max_tokens: maxTokens
            });

            const options = {
                hostname: this.groqApiUrl,
                path: '/openai/v1/chat/completions',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.groqApiKey}`,
                    'Content-Length': Buffer.byteLength(requestBody)
                }
            };

            const req = https.request(options, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    try {
                        const result = JSON.parse(body);
                        if (result.error) {
                            console.log(`   ❌ Error: ${result.error.message}`);
                            reject(new Error(result.error.message));
                            return;
                        }

                        const responseContent = result.choices[0]?.message?.content || '';
                        console.log(`   ✅ Response received`);

                        // Parse JSON from response
                        try {
                            let jsonStr = responseContent;
                            if (responseContent.includes('```json')) {
                                jsonStr = responseContent.split('```json')[1].split('```')[0].trim();
                            } else if (responseContent.includes('```')) {
                                jsonStr = responseContent.split('```')[1].split('```')[0].trim();
                            }
                            resolve(JSON.parse(jsonStr));
                        } catch (parseErr) {
                            console.log(`   ⚠️ JSON parse failed, returning raw`);
                            resolve({ raw: responseContent });
                        }
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            req.on('error', reject);
            req.setTimeout(60000, () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });

            req.write(requestBody);
            req.end();
        });
    }

    // ========================================
    // AGENT 1: CONTENT RETRIEVER
    // Fetches book content from Azure Search
    // ========================================

    async retrieveBookContent(bookTitle, maxChunks = 20) {
        console.log(`\n📖 CONTENT RETRIEVER: Fetching content for "${bookTitle}"...`);

        try {
            // First try flexible search with the book title (like image search does)
            const searchResults = await this.searchClient.search(bookTitle, {
                top: maxChunks,
                orderBy: ['pageNumber asc', 'chunkIndex asc'],
                select: ['bookName', 'pageNumber', 'content', 'chunkIndex'],
                highlightFields: 'content'
            });

            const chunks = [];
            let foundBookName = null;

            for await (const result of searchResults.results) {
                // Only include results from the same book (first match determines the book)
                if (!foundBookName) {
                    foundBookName = result.document.bookName;
                }

                // Include chunks from the same book
                if (result.document.bookName === foundBookName) {
                    chunks.push({
                        page: result.document.pageNumber,
                        content: result.document.content,
                        bookName: result.document.bookName
                    });
                }
            }

            console.log(`   ✅ Retrieved ${chunks.length} content chunks from "${foundBookName || 'unknown'}"`);
            return chunks;

        } catch (error) {
            console.error(`   ❌ Content retrieval error:`, error.message);
            return [];
        }
    }

    // ========================================
    // MAIN: GENERATE BOOK SUMMARY
    // Orchestrates all agents
    // ========================================

    async generateBookSummary(bookId, bookTitle) {
        console.log('\n' + '═'.repeat(60));
        console.log('🚀 BOOK SUMMARY PIPELINE STARTED');
        console.log(`📚 Book: ${bookTitle} (ID: ${bookId})`);
        console.log('═'.repeat(60));

        const startTime = Date.now();
        const agentOutputs = {};

        try {
            // Check cache first
            const cached = await this.getCachedSummary(bookId);
            if (cached) {
                console.log('   📦 Returning cached summary');
                return {
                    success: true,
                    cached: true,
                    ...cached
                };
            }

            // AGENT 1: Retrieve book content
            const contentChunks = await this.retrieveBookContent(bookTitle);

            if (contentChunks.length === 0) {
                return {
                    success: false,
                    error: 'Book content not found in search index. The book may not be indexed yet.'
                };
            }

            // Combine content for analysis (limit to avoid token limits)
            const combinedContent = contentChunks
                .map(c => c.content)
                .join('\n\n')
                .substring(0, 15000); // ~4000 tokens

            agentOutputs.contentRetriever = {
                agent: ReadingAssistantAgent.AGENTS.CONTENT_RETRIEVER.name,
                chunksRetrieved: contentChunks.length,
                totalCharacters: combinedContent.length
            };

            // AGENT 2: Generate summary
            console.log('\n📝 AGENT 2: Generating summary...');
            const summaryResult = await this.callGroqAgent(
                'SUMMARY_GENERATOR',
                `Book Title: ${bookTitle}\n\nBook Content:\n${combinedContent}`,
                1500
            );
            agentOutputs.summaryGenerator = {
                agent: ReadingAssistantAgent.AGENTS.SUMMARY_GENERATOR.name,
                ...summaryResult
            };

            // AGENT 3: Extract key points
            console.log('\n💡 AGENT 3: Extracting key points...');
            const keyPointsResult = await this.callGroqAgent(
                'KEY_POINTS_EXTRACTOR',
                `Book Title: ${bookTitle}\n\nBook Content:\n${combinedContent}`,
                1500
            );
            agentOutputs.keyPointsExtractor = {
                agent: ReadingAssistantAgent.AGENTS.KEY_POINTS_EXTRACTOR.name,
                ...keyPointsResult
            };

            // AGENT 4: Analyze metadata
            console.log('\n📊 AGENT 4: Analyzing metadata...');
            const metadataResult = await this.callGroqAgent(
                'METADATA_ANALYZER',
                `Book Title: ${bookTitle}\n\nBook Content Sample (first 5000 chars):\n${combinedContent.substring(0, 5000)}`,
                500
            );
            agentOutputs.metadataAnalyzer = {
                agent: ReadingAssistantAgent.AGENTS.METADATA_ANALYZER.name,
                ...metadataResult
            };

            // Compile final result
            const finalResult = {
                bookId,
                bookTitle,
                summary: summaryResult.summary || summaryResult.raw || 'Summary generation failed',
                centralTheme: summaryResult.central_theme || null,
                targetAudience: summaryResult.target_audience || null,
                tone: summaryResult.tone || null,
                keyTakeaways: keyPointsResult.key_takeaways || [],
                memorableIdeas: keyPointsResult.memorable_ideas || [],
                mainConcepts: keyPointsResult.main_concepts || [],
                practicalApplications: keyPointsResult.practical_applications || [],
                difficultyLevel: metadataResult.difficulty_level || 'intermediate',
                estimatedReadingHours: metadataResult.estimated_reading_hours || null,
                prerequisites: metadataResult.prerequisites || [],
                genreTags: metadataResult.genre_tags || [],
                agentInsights: agentOutputs
            };

            // Cache the result
            await this.cacheSummary(bookId, finalResult);

            const endTime = Date.now();

            console.log('\n' + '═'.repeat(60));
            console.log('✅ BOOK SUMMARY PIPELINE COMPLETE');
            console.log(`   ⏱️ Total time: ${Math.round((endTime - startTime) / 1000)}s`);
            console.log('═'.repeat(60) + '\n');

            return {
                success: true,
                cached: false,
                processingTimeMs: endTime - startTime,
                ...finalResult
            };

        } catch (error) {
            console.error('❌ Pipeline Error:', error);
            return {
                success: false,
                error: error.message,
                agentInsights: agentOutputs
            };
        }
    }

    // ========================================
    // QUICK SUMMARY (Shorter, faster)
    // ========================================

    async generateQuickSummary(bookId, bookTitle) {
        console.log(`\n⚡ Generating quick summary for "${bookTitle}"...`);

        try {
            // Check cache
            const cached = await this.getCachedSummary(bookId, 'quick');
            if (cached) {
                return { success: true, cached: true, ...cached };
            }

            // Get content
            const contentChunks = await this.retrieveBookContent(bookTitle, 10);
            if (contentChunks.length === 0) {
                return { success: false, error: 'Book content not indexed' };
            }

            const content = contentChunks.map(c => c.content).join('\n').substring(0, 8000);

            // Single agent call for quick summary
            const result = await this.callGroqAgent('SUMMARY_GENERATOR',
                `Book: ${bookTitle}\n\nContent:\n${content}`
            );

            const quickResult = {
                bookId,
                bookTitle,
                summaryType: 'quick',
                summary: result.summary || result.raw,
                centralTheme: result.central_theme
            };

            // Cache it
            await this.cacheSummary(bookId, quickResult, 'quick');

            return { success: true, cached: false, ...quickResult };

        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // ========================================
    // CACHING METHODS
    // ========================================

    async getCachedSummary(bookId, summaryType = 'full') {
        try {
            const [rows] = await pool.query(
                `SELECT * FROM book_summaries 
                 WHERE book_id = ? AND summary_type = ? 
                 ORDER BY generated_at DESC LIMIT 1`,
                [bookId, summaryType]
            );

            if (rows.length > 0) {
                const cached = rows[0];
                return {
                    bookId: cached.book_id,
                    summary: cached.summary_content,
                    keyPoints: cached.key_points ? JSON.parse(cached.key_points) : null,
                    difficultyLevel: cached.difficulty_level,
                    readingTimeMinutes: cached.reading_time_minutes,
                    generatedAt: cached.generated_at
                };
            }
            return null;
        } catch (error) {
            console.error('Cache read error:', error);
            return null;
        }
    }

    async cacheSummary(bookId, summaryData, summaryType = 'full') {
        try {
            const keyPoints = {
                keyTakeaways: summaryData.keyTakeaways,
                memorableIdeas: summaryData.memorableIdeas,
                mainConcepts: summaryData.mainConcepts,
                practicalApplications: summaryData.practicalApplications,
                prerequisites: summaryData.prerequisites,
                genreTags: summaryData.genreTags
            };

            await pool.query(
                `INSERT INTO book_summaries 
                 (book_id, summary_type, summary_content, key_points, reading_time_minutes, difficulty_level)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                 summary_content = VALUES(summary_content),
                 key_points = VALUES(key_points),
                 reading_time_minutes = VALUES(reading_time_minutes),
                 difficulty_level = VALUES(difficulty_level),
                 generated_at = CURRENT_TIMESTAMP`,
                [
                    bookId,
                    summaryType,
                    summaryData.summary,
                    JSON.stringify(keyPoints),
                    summaryData.estimatedReadingHours ? summaryData.estimatedReadingHours * 60 : null,
                    summaryData.difficultyLevel
                ]
            );
            console.log('   💾 Summary cached successfully');
        } catch (error) {
            console.error('Cache write error:', error);
        }
    }

    // ========================================
    // CHECK BOOK OWNERSHIP
    // ========================================

    async checkBookAccess(userId, bookId) {
        try {
            // Check if user purchased the book
            const [orders] = await pool.query(`
                SELECT o.id, o.mode, o.rental_end
                FROM orders o
                JOIN order_items oi ON o.id = oi.order_id
                WHERE oi.book_id = ? AND o.user_id = ? AND o.payment_status = 'completed'
                ORDER BY o.created_at DESC
                LIMIT 1
            `, [bookId, userId]);

            if (orders.length > 0) {
                const order = orders[0];

                // If rental, check if still valid
                if (order.mode === 'rent') {
                    const now = new Date();
                    const expiryDate = new Date(order.rental_end);
                    if (now > expiryDate) {
                        return { hasAccess: false, reason: 'Rental expired' };
                    }
                }

                return { hasAccess: true, accessType: order.mode };
            }

            // Check if received as gift
            const [gifts] = await pool.query(`
                SELECT id FROM gifts
                WHERE book_id = ? AND recipient_user_id = ?
                LIMIT 1
            `, [bookId, userId]);

            if (gifts.length > 0) {
                return { hasAccess: true, accessType: 'gift' };
            }

            return { hasAccess: false, reason: 'Book not owned' };

        } catch (error) {
            console.error('Access check error:', error);
            return { hasAccess: false, reason: 'Error checking access' };
        }
    }
}

module.exports = ReadingAssistantAgent;
