// backend/routes/recommendations.js
// TRUE MULTI-AGENT AI RECOMMENDATION SYSTEM
// Features: 5 Specialized Agents + Coordinator Agent
// Uses: Groq API (FREE) with Llama 3.3 70B

const router = require('express').Router();
const pool = require('../config/database');
const auth = require('../middleware/auth');
const https = require('https');

// ============================================
// GROQ API CONFIGURATION (FREE!)
// ============================================

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_API_URL = 'api.groq.com';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

// Check if API key is configured
if (!GROQ_API_KEY) {
    console.warn('⚠️ GROQ_API_KEY not set in environment variables');
}

// ============================================
// AGENT DEFINITIONS - Each agent is specialized
// ============================================

const AGENTS = {
    INTENT: {
        name: '🎯 Intent Agent',
        role: 'Parse and understand user query',
        systemPrompt: `You are the Intent Analysis Agent. Your ONLY job is to extract structured information from user queries about books.

Analyze the query and extract:
1. genre: The book category (fiction, mystery, thriller, romance, sci-fi, fantasy, horror, biography, history, self-help, business, philosophy, psychology, etc.) - null if not mentioned
2. mood: The emotional feel (exciting, relaxing, inspiring, thought-provoking, funny, emotional, dark, uplifting, romantic, mysterious) - null if not mentioned
3. length_preference: short/medium/long - null if not mentioned
4. max_budget: number in rupees - null if not mentioned
5. keywords: array of search terms to find matching books in the database.
   IMPORTANT: Include the original words PLUS synonyms, related terms, and words commonly found in book titles/descriptions for this topic.
   Think about famous books in this category and what words appear in their titles.
   Generate at least 8-10 diverse keywords to maximize search matches.
6. user_emotion: detected emotional state (stressed, sad, happy, bored, curious) - null if not clear
7. book_count: how many books the user wants (1-10). Use these rules:
   - "a book", "one book", "1 book" → 1
   - "two books", "2 books", "a couple" → 2
   - "three books", "3 books", "few books" → 3
   - "some books", "books", "recommendations" → 5
   - If user says specific number like "5 books" → that number
   - If unclear, default to 5

RESPOND ONLY WITH VALID JSON, no other text:
{"genre": "...", "mood": "...", "length_preference": "...", "max_budget": null, "keywords": [], "user_emotion": null, "book_count": 5}`
    },

    HISTORY: {
        name: '📚 History Agent',
        role: 'Analyze user purchase patterns',
        systemPrompt: `You are the User History Analysis Agent. Your job is to analyze a user's purchase history and identify patterns.

Given purchase history data, identify:
1. favorite_genres: top genres the user buys
2. preferred_authors: authors they return to
3. price_range: typical spending (budget/mid-range/premium)
4. reading_pattern: type of reader they are
5. recommendation_strategy: how to approach recommendations for this user

RESPOND ONLY WITH VALID JSON:
{"favorite_genres": [], "preferred_authors": [], "price_range": "...", "reading_pattern": "...", "recommendation_strategy": "..."}`
    },

    MOOD: {
        name: '💭 Mood Expert Agent',
        role: 'Map emotions to book characteristics',
        systemPrompt: `You are the Mood Expert Agent. You understand the emotional and psychological aspects of reading.

Given a user's mood/emotion and what they're looking for, determine:
1. book_characteristics: what kind of books would help (e.g., "light, humorous, easy to read")
2. avoid_characteristics: what to avoid (e.g., "heavy themes, dark endings")
3. search_keywords: Keywords to search for matching books in the database.
   Think about words that commonly appear in book TITLES and DESCRIPTIONS for this type of content.
   Include synonyms and semantically related terms.
   Think of famous/popular books in this category and include words from their titles.
   Generate at least 8-10 diverse keywords.
4. page_count_suggestion: ideal page count range
5. reasoning: brief explanation of your mood analysis

RESPOND ONLY WITH VALID JSON:
{"book_characteristics": "...", "avoid_characteristics": "...", "search_keywords": [], "page_count_suggestion": {"min": 0, "max": 500}, "reasoning": "..."}`
    },

    SEARCH: {
        name: '🔍 Search Agent',
        role: 'Find matching books from database',
        systemPrompt: `You are the Search Strategy Agent. Given search criteria, you determine the best search approach.

Analyze the criteria and output:
1. primary_search: main search method (by_category, by_keywords, by_author, by_popularity)
2. search_terms: specific terms to search
3. filters: price, page count, stock filters
4. fallback_strategy: what to do if primary search fails
5. limit: how many books to fetch

RESPOND ONLY WITH VALID JSON:
{"primary_search": "...", "search_terms": [], "filters": {}, "fallback_strategy": "...", "limit": 20}`
    },

    RANKING: {
        name: '📊 Ranking Agent',
        role: 'Score and rank book matches',
        systemPrompt: `You are the Ranking Agent. You score books based on how well they match user preferences.

Given books and user preferences, for each book calculate:
1. relevance_score: 0-100 based on genre/keyword match
2. mood_score: 0-100 based on mood/emotional fit
3. rating_score: 0-100 based on avg_rating (5 stars = 100) and review_count (more reviews = higher trust)
4. value_score: 0-100 based on price vs quality
5. personalization_score: 0-100 based on user history match
6. final_score: weighted combination (relevance 30%, mood 20%, rating 25%, value 10%, personalization 15%)
7. recommendation_reason: why this book is recommended (mention rating if high)

IMPORTANT: 
- Prioritize books with higher ratings (4+ stars) and more reviews
- A book with 4.5 stars and 50 reviews is better than 5 stars with 1 review
- The user may request a specific number of books - rank ALL books but the system will pick the top N

Output ranked books with scores (rank as many as provided, the system will limit based on user request).

RESPOND ONLY WITH VALID JSON:
{"ranked_books": [{"book_id": 1, "final_score": 85, "scores": {...}, "reason": "..."}]}`
    },

    COORDINATOR: {
        name: '🤖 Coordinator Agent',
        role: 'Orchestrate all agents and generate response',
        systemPrompt: `You are the Coordinator Agent. You synthesize outputs from all specialized agents into a final recommendation.

Given all agent outputs, create:
1. message: A friendly, personalized message explaining the recommendations (2-3 sentences)
2. summary: Brief summary of how you reached these recommendations
3. confidence: Your confidence level (high/medium/low)

Be conversational and explain WHY these books match what the user asked for.

RESPOND ONLY WITH VALID JSON:
{"message": "...", "summary": "...", "confidence": "..."}`
    }
};

// ============================================
// GROQ API CALL FUNCTION
// ============================================

async function callGroqAgent(agentType, userMessage, context = '') {
    const agent = AGENTS[agentType];

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`${agent.name} starting...`);
    console.log(`   Role: ${agent.role}`);

    return new Promise((resolve, reject) => {
        const requestBody = JSON.stringify({
            model: GROQ_MODEL,
            messages: [
                { role: 'system', content: agent.systemPrompt },
                { role: 'user', content: context ? `${context}\n\nUser Query: ${userMessage}` : userMessage }
            ],
            temperature: 0.3,
            max_tokens: 1024
        });

        const options = {
            hostname: GROQ_API_URL,
            path: '/openai/v1/chat/completions',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${GROQ_API_KEY}`,
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

                    const content = result.choices[0]?.message?.content || '';
                    console.log(`   ✅ Response received`);

                    // Try to parse JSON from response
                    try {
                        // Extract JSON from response (handle markdown code blocks)
                        let jsonStr = content;
                        if (content.includes('```json')) {
                            jsonStr = content.split('```json')[1].split('```')[0].trim();
                        } else if (content.includes('```')) {
                            jsonStr = content.split('```')[1].split('```')[0].trim();
                        }

                        const parsed = JSON.parse(jsonStr);
                        console.log(`   📤 Parsed output:`, JSON.stringify(parsed).substring(0, 100) + '...');
                        resolve(parsed);
                    } catch (parseErr) {
                        console.log(`   ⚠️ Could not parse JSON, returning raw`);
                        resolve({ raw: content });
                    }
                } catch (e) {
                    console.log(`   ❌ Parse error:`, e.message);
                    reject(e);
                }
            });
        });

        req.on('error', (e) => {
            console.log(`   ❌ Request error:`, e.message);
            reject(e);
        });

        req.setTimeout(30000, () => {
            console.log(`   ⚠️ Timeout`);
            req.destroy();
            reject(new Error('Request timeout'));
        });

        req.write(requestBody);
        req.end();
    });
}

// ============================================
// DATABASE QUERY FUNCTIONS
// ============================================

async function searchBooksByCategory(category, limit = 20) {
    const [books] = await pool.query(`
        SELECT id, title, author, category, price, stock, page_count, 
               description, image_url, created_at
        FROM books 
        WHERE LOWER(category) LIKE LOWER(?) AND stock > 0
        ORDER BY created_at DESC
        LIMIT ?
    `, [`%${category}%`, limit]);
    return books;
}

async function searchBooksByKeywords(keywords, limit = 20) {
    if (!keywords || keywords.length === 0) return [];

    const conditions = keywords.map(() =>
        '(LOWER(title) LIKE LOWER(?) OR LOWER(description) LIKE LOWER(?) OR LOWER(author) LIKE LOWER(?) OR LOWER(category) LIKE LOWER(?))'
    ).join(' OR ');

    const params = keywords.flatMap(kw => [`%${kw}%`, `%${kw}%`, `%${kw}%`, `%${kw}%`]);
    params.push(limit);

    const [books] = await pool.query(`
        SELECT id, title, author, category, price, stock, page_count, 
               description, image_url, created_at
        FROM books 
        WHERE stock > 0 AND (${conditions})
        ORDER BY created_at DESC
        LIMIT ?
    `, params);
    return books;
}

async function getUserPurchaseHistory(userId) {
    if (!userId) return null;

    const [purchases] = await pool.query(`
        SELECT DISTINCT 
            b.id, b.title, b.author, b.category, b.price, b.page_count,
            o.created_at as purchase_date
        FROM orders o
        JOIN order_items oi ON o.id = oi.order_id
        JOIN books b ON oi.book_id = b.id
        WHERE o.user_id = ? AND o.payment_status = 'completed'
        ORDER BY o.created_at DESC
        LIMIT 20
    `, [userId]);

    return purchases;
}

async function getPopularBooks(limit = 10) {
    const [books] = await pool.query(`
        SELECT b.*, COUNT(oi.id) as order_count,
               COALESCE(AVG(r.rating), 0) as avg_rating,
               COUNT(DISTINCT r.id) as review_count
        FROM books b
        LEFT JOIN order_items oi ON b.id = oi.book_id
        LEFT JOIN reviews r ON b.id = r.book_id
        WHERE b.stock > 0
        GROUP BY b.id
        ORDER BY order_count DESC, avg_rating DESC, b.created_at DESC
        LIMIT ?
    `, [limit]);
    return books;
}

// Get ratings for a list of books
async function getBookRatings(bookIds) {
    if (!bookIds || bookIds.length === 0) return {};

    const [ratings] = await pool.query(`
        SELECT book_id, 
               ROUND(AVG(rating), 1) as avg_rating, 
               COUNT(*) as review_count
        FROM reviews 
        WHERE book_id IN (?)
        GROUP BY book_id
    `, [bookIds]);

    const ratingsMap = {};
    ratings.forEach(r => {
        ratingsMap[r.book_id] = {
            avg_rating: r.avg_rating,
            review_count: r.review_count
        };
    });
    return ratingsMap;
}

async function filterBooks(books, filters) {
    let filtered = [...books];

    if (filters.max_price) {
        filtered = filtered.filter(b => b.price <= filters.max_price);
    }
    if (filters.min_pages) {
        filtered = filtered.filter(b => (b.page_count || 200) >= filters.min_pages);
    }
    if (filters.max_pages) {
        filtered = filtered.filter(b => (b.page_count || 200) <= filters.max_pages);
    }

    return filtered;
}

// NOTE: Synonym expansion is now handled by the AI agents (INTENT and MOOD agents)
// They generate expanded keywords with synonyms and related terms automatically

// ============================================
// MULTI-AGENT ORCHESTRATION
// ============================================

async function runMultiAgentRecommendation(userQuery, userId) {
    console.log('\n' + '═'.repeat(60));
    console.log('🚀 MULTI-AGENT RECOMMENDATION SYSTEM');
    console.log('═'.repeat(60));
    console.log(`📝 Query: "${userQuery}"`);
    console.log(`👤 User ID: ${userId || 'anonymous'}`);
    console.log('═'.repeat(60));

    const agentOutputs = {};
    const startTime = Date.now();

    try {
        // ========== AGENT 1: Intent Analysis ==========
        console.log('\n🎯 PHASE 1: Intent Analysis');
        const intentResult = await callGroqAgent('INTENT', userQuery);
        agentOutputs.intent = intentResult;

        // ========== AGENT 2: User History Analysis ==========
        console.log('\n📚 PHASE 2: User History Analysis');
        const purchaseHistory = await getUserPurchaseHistory(userId);

        if (purchaseHistory && purchaseHistory.length > 0) {
            const historyContext = `User's purchase history:\n${purchaseHistory.map(p =>
                `- "${p.title}" by ${p.author} (${p.category}, ₹${p.price})`
            ).join('\n')}`;

            const historyResult = await callGroqAgent('HISTORY', userQuery, historyContext);
            agentOutputs.history = historyResult;
        } else {
            console.log('   ℹ️ No purchase history found - skipping personalization');
            agentOutputs.history = {
                favorite_genres: [],
                recommendation_strategy: 'Show popular books as user is new'
            };
        }

        // ========== AGENT 3: Mood Analysis ==========
        console.log('\n💭 PHASE 3: Mood Analysis');
        const moodContext = `Intent analysis: ${JSON.stringify(intentResult)}`;
        const moodResult = await callGroqAgent('MOOD', userQuery, moodContext);
        agentOutputs.mood = moodResult;

        // ========== AGENT 4: Search Strategy ==========
        console.log('\n🔍 PHASE 4: Search Strategy');
        const searchContext = `
Intent: ${JSON.stringify(intentResult)}
User History: ${JSON.stringify(agentOutputs.history)}
Mood Analysis: ${JSON.stringify(moodResult)}`;

        const searchResult = await callGroqAgent('SEARCH', userQuery, searchContext);
        agentOutputs.search = searchResult;

        // ========== Execute Database Search ==========
        console.log('\n💾 PHASE 5: Database Search');
        let books = [];
        let matchedBooks = []; // Track books that actually match the query

        // Primary search based on Search Agent's strategy
        if (intentResult.genre) {
            console.log(`   Searching by genre: ${intentResult.genre}`);
            books = await searchBooksByCategory(intentResult.genre, 30);
            matchedBooks = [...books]; // These are matched books
        }

        // ALWAYS do keyword search to find more relevant books
        // Keywords are already expanded with synonyms by the AI agents
        const keywords = [
            ...(intentResult.keywords || []),
            ...(moodResult.search_keywords || []),
            ...(searchResult.search_terms || [])
        ].filter(Boolean);

        // Remove duplicates from combined keywords
        const allKeywords = [...new Set(keywords.map(k => k.toLowerCase()))];

        if (allKeywords.length > 0) {
            console.log(`   Searching by keywords: ${allKeywords.join(', ')}`);
            const keywordBooks = await searchBooksByKeywords(allKeywords, 30);

            // Add to matched books (these are relevant matches)
            for (const book of keywordBooks) {
                if (!matchedBooks.find(b => b.id === book.id)) {
                    matchedBooks.push(book);
                }
            }
            books = [...books, ...keywordBooks];
        }

        // Get requested count for smart fallback
        const requestedCount = Math.min(Math.max(intentResult.book_count || 5, 1), 10);

        // Smart fallback: Only fill remaining slots with popular books
        // Keep matched books and only add popular books to fill the gap
        if (matchedBooks.length < requestedCount) {
            const neededCount = requestedCount - matchedBooks.length + 5; // Get extra for filtering
            console.log(`   Found ${matchedBooks.length} matching books, need ${requestedCount}. Fetching ${neededCount} popular books to fill gaps.`);
            const popularBooks = await getPopularBooks(neededCount);

            // Add popular books only if not already in matched books
            for (const book of popularBooks) {
                if (!books.find(b => b.id === book.id)) {
                    books.push(book);
                }
            }
        }

        // Remove duplicates
        const uniqueBooks = [];
        const seenIds = new Set();
        for (const book of books) {
            if (!seenIds.has(book.id)) {
                seenIds.add(book.id);
                uniqueBooks.push(book);
            }
        }
        books = uniqueBooks;

        console.log(`   📚 Found ${books.length} unique books`);

        // Apply filters
        const filters = {
            max_price: intentResult.max_budget,
            min_pages: moodResult.page_count_suggestion?.min,
            max_pages: moodResult.page_count_suggestion?.max
        };

        books = await filterBooks(books, filters);
        console.log(`   📚 After filtering: ${books.length} books`);

        // ========== Get Ratings for Books ==========
        console.log('\n⭐ PHASE 5.5: Fetching Ratings & Reviews');
        const bookIds = books.map(b => b.id);
        const ratingsMap = await getBookRatings(bookIds);

        // Add ratings to books and mark if they are matched or fallback
        const matchedBookIds = new Set(matchedBooks.map(b => b.id));
        books = books.map(b => ({
            ...b,
            avg_rating: ratingsMap[b.id]?.avg_rating || 0,
            review_count: ratingsMap[b.id]?.review_count || 0,
            isMatched: matchedBookIds.has(b.id) // Mark if book matched the query
        }));
        console.log(`   ⭐ Added ratings for ${Object.keys(ratingsMap).length} books`);
        console.log(`   🎯 ${matchedBooks.length} books matched query, ${books.length - matchedBooks.length} are fallback`);

        // ========== AGENT 5: Ranking ==========
        console.log('\n📊 PHASE 6: Ranking');
        const booksForRanking = books.slice(0, 15).map(b => ({
            id: b.id,
            title: b.title,
            author: b.author,
            category: b.category,
            price: b.price,
            pages: b.page_count,
            avg_rating: b.avg_rating,
            review_count: b.review_count,
            isMatched: b.isMatched, // Tell ranking agent which books matched
            description: (b.description || '').substring(0, 100)
        }));

        const rankingContext = `
User Query: "${userQuery}"
Intent: ${JSON.stringify(intentResult)}
Mood: ${JSON.stringify(moodResult)}
User Preferences: ${JSON.stringify(agentOutputs.history)}

Books to rank (includes ratings and reviews):
${JSON.stringify(booksForRanking, null, 2)}

IMPORTANT: 
1. Books with "isMatched": true are directly relevant to the user's query - PRIORITIZE these books
2. Books with "isMatched": false are fallback popular books - only recommend these to fill remaining slots
3. Consider avg_rating (0-5 stars) and review_count when ranking
4. Higher rated books with more reviews should be preferred
5. ALWAYS put matched books before fallback books in the ranking`;

        const rankingResult = await callGroqAgent('RANKING',
            'Rank these books based on how well they match the user preferences',
            rankingContext
        );
        agentOutputs.ranking = rankingResult;

        // ========== Get Top Ranked Books ==========
        // Use book_count from intent (already defined earlier)
        console.log(`   📚 User requested ${requestedCount} book(s)`);

        let finalBooks = [];

        if (rankingResult.ranked_books && rankingResult.ranked_books.length > 0) {
            // Sort by ranking agent's scores, but boost matched books
            const rankedBooks = rankingResult.ranked_books
                .map(r => {
                    const book = books.find(b => b.id === r.book_id);
                    return {
                        ...r,
                        isMatched: book?.isMatched || false,
                        // Boost matched books by adding 50 to their score for sorting priority
                        sortScore: (r.final_score || 0) + (book?.isMatched ? 50 : 0)
                    };
                })
                .sort((a, b) => b.sortScore - a.sortScore)
                .slice(0, requestedCount);

            // Get full book details in ranked order
            for (const rankInfo of rankedBooks) {
                const book = books.find(b => b.id === rankInfo.book_id);
                if (book) {
                    finalBooks.push({
                        ...book,
                        match_score: rankInfo.final_score || 80,
                        recommendation_reason: rankInfo.reason || (book.isMatched ? 'Matches your search criteria' : 'Popular recommendation')
                    });
                }
            }
        }

        // Fallback if ranking didn't work - prioritize matched books
        if (finalBooks.length < requestedCount) {
            console.log(`   ⚠️ Ranking returned ${finalBooks.length} books, using fallback to fill ${requestedCount - finalBooks.length} slots`);
            const existingIds = new Set(finalBooks.map(b => b.id));

            // First, add remaining matched books
            for (const book of books.filter(b => b.isMatched && !existingIds.has(b.id))) {
                if (finalBooks.length >= requestedCount) break;
                finalBooks.push({
                    ...book,
                    match_score: 75,
                    recommendation_reason: 'Matches your search criteria'
                });
            }

            // Then, add fallback books if still needed
            for (const book of books.filter(b => !b.isMatched && !existingIds.has(b.id))) {
                if (finalBooks.length >= requestedCount) break;
                finalBooks.push({
                    ...book,
                    match_score: 60,
                    recommendation_reason: 'Popular recommendation'
                });
            }
        }

        // ========== AGENT 6: Coordinator (Final Response) ==========
        console.log('\n🤖 PHASE 7: Generating Response');
        const coordinatorContext = `
User Query: "${userQuery}"

Agent Outputs:
- Intent Agent found: genre="${intentResult.genre}", mood="${intentResult.mood}", budget=${intentResult.max_budget}
- History Agent found: ${agentOutputs.history.recommendation_strategy || 'No history'}
- Mood Expert suggests: ${moodResult.book_characteristics || 'general recommendations'}
- Ranking Agent selected ${finalBooks.length} top books

Top Recommended Books:
${finalBooks.map((b, i) => `${i + 1}. "${b.title}" by ${b.author} (₹${b.price}) - ${b.recommendation_reason}`).join('\n')}`;

        const coordinatorResult = await callGroqAgent('COORDINATOR',
            'Generate a friendly response explaining these recommendations',
            coordinatorContext
        );
        agentOutputs.coordinator = coordinatorResult;

        // ========== Final Output ==========
        const endTime = Date.now();

        console.log('\n' + '═'.repeat(60));
        console.log('✅ MULTI-AGENT PROCESS COMPLETE');
        console.log(`   ⏱️ Total time: ${endTime - startTime}ms`);
        console.log(`   📚 Books recommended: ${finalBooks.length}`);
        console.log('═'.repeat(60) + '\n');

        return {
            success: true,
            message: coordinatorResult.message || "Here are your personalized recommendations!",
            recommendations: finalBooks.map(book => ({
                id: book.id,
                title: book.title,
                author: book.author,
                price: book.price,
                page_count: book.page_count,
                category: book.category,
                image_url: book.image_url,
                description: book.description,
                stock: book.stock,
                match_score: book.match_score,
                recommendation_reason: book.recommendation_reason
            })),
            agentInsights: {
                intent: {
                    agent: AGENTS.INTENT.name,
                    detected_genre: intentResult.genre,
                    detected_mood: intentResult.mood,
                    budget: intentResult.max_budget,
                    book_count: requestedCount,
                    keywords: intentResult.keywords
                },
                history: {
                    agent: AGENTS.HISTORY.name,
                    favorite_genres: agentOutputs.history.favorite_genres,
                    strategy: agentOutputs.history.recommendation_strategy
                },
                mood: {
                    agent: AGENTS.MOOD.name,
                    characteristics: moodResult.book_characteristics,
                    reasoning: moodResult.reasoning
                },
                ranking: {
                    agent: AGENTS.RANKING.name,
                    books_evaluated: books.length,
                    top_scores: rankingResult.ranked_books?.slice(0, 3).map(r => ({
                        title: books.find(b => b.id === r.book_id)?.title,
                        score: r.final_score
                    }))
                },
                coordinator: {
                    agent: AGENTS.COORDINATOR.name,
                    confidence: coordinatorResult.confidence,
                    summary: coordinatorResult.summary
                }
            },
            debug: {
                totalAgentCalls: 6,
                processingTimeMs: endTime - startTime,
                booksSearched: books.length,
                booksRecommended: finalBooks.length
            }
        };

    } catch (error) {
        console.error('❌ Multi-Agent Error:', error);

        // Fallback: return popular books
        const popularBooks = await getPopularBooks(5);

        return {
            success: false,
            message: "I found some popular books you might enjoy!",
            recommendations: popularBooks,
            error: error.message,
            debug: {
                fallbackUsed: true
            }
        };
    }
}

// ============================================
// API ROUTES
// ============================================

/**
 * POST /api/recommendations/chat
 * Main multi-agent chat endpoint
 */
router.post('/chat', auth, async (req, res) => {
    try {
        const { message } = req.body;
        const userId = req.user?.id;

        if (!message || message.trim().length < 2) {
            return res.status(400).json({
                message: 'Please provide a more detailed query'
            });
        }

        const result = await runMultiAgentRecommendation(message, userId);
        res.json(result);

    } catch (err) {
        console.error('❌ Chat Error:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to get recommendations',
            error: err.message
        });
    }
});

/**
 * GET /api/recommendations/test
 * Test the multi-agent system
 */
router.get('/test', async (req, res) => {
    try {
        const testQuery = req.query.q || 'I want a philosophy book under 300 rupees';

        console.log('\n🧪 TEST MODE');
        console.log(`   Query: "${testQuery}"`);

        const result = await runMultiAgentRecommendation(testQuery, null);
        res.json(result);

    } catch (err) {
        res.status(500).json({
            status: 'error',
            error: err.message
        });
    }
});

/**
 * GET /api/recommendations/personalized
 * Get personalized recommendations
 */
router.get('/personalized', auth, async (req, res) => {
    try {
        const userId = req.user.id;
        const query = "Recommend books based on my reading preferences and purchase history";

        const result = await runMultiAgentRecommendation(query, userId);

        res.json({
            type: 'personalized',
            title: 'Recommended For You',
            books: result.recommendations,
            aiMessage: result.message,
            insights: result.agentInsights
        });

    } catch (err) {
        console.error('Personalized recommendations error:', err);

        // Fallback to popular
        const popular = await getPopularBooks(5);
        res.json({
            type: 'popular',
            title: 'Popular Books',
            books: popular
        });
    }
});

/**
 * GET /api/recommendations/agents
 * Get information about the agents
 */
router.get('/agents', (req, res) => {
    res.json({
        system: 'Multi-Agent Recommendation System',
        model: GROQ_MODEL,
        agents: Object.entries(AGENTS).map(([key, agent]) => ({
            id: key,
            name: agent.name,
            role: agent.role
        })),
        architecture: {
            description: 'Coordinated multi-agent system where specialized agents collaborate',
            flow: [
                '1. Intent Agent parses user query',
                '2. History Agent analyzes user preferences',
                '3. Mood Expert maps emotions to book traits',
                '4. Search Agent determines search strategy',
                '5. Ranking Agent scores and ranks matches',
                '6. Coordinator Agent synthesizes final response'
            ]
        }
    });
});

module.exports = router;
