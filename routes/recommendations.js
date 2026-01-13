// backend/routes/recommendations.js
// AI-Based Recommendation System with Multi-Agent Architecture

const router = require('express').Router();
const pool = require('../config/database');
const auth = require('../middleware/auth');
const https = require('https');

// HuggingFace API Configuration
const HF_API_TOKEN = process.env.HUGGINGFACE_API_TOKEN;
const HF_API_URL = 'https://api-inference.huggingface.co/models/facebook/bart-large-mnli';

// Agent Weights (as per requirements)
const WEIGHTS = {
    genre: 0.40,
    mood: 0.25,
    length: 0.25,
    history: 0.10
};

// Genre categories for classification
const GENRE_LABELS = [
    'fiction', 'non-fiction', 'mystery', 'thriller', 'romance', 
    'science fiction', 'fantasy', 'horror', 'biography', 'history',
    'self-help', 'business', 'economics', 'science', 'technology',
    'philosophy', 'psychology', 'education', 'travel', 'cooking',
    'art', 'music', 'sports', 'religion', 'politics', 'health'
];

// Mood/Feel categories
const MOOD_LABELS = [
    'exciting', 'thrilling', 'relaxing', 'inspiring', 'thought-provoking',
    'funny', 'emotional', 'dark', 'uplifting', 'adventurous',
    'romantic', 'mysterious', 'educational', 'motivational', 'peaceful'
];

// Length categories
const LENGTH_LABELS = ['short book', 'medium length book', 'long book'];

// ============================================
// HUGGINGFACE ZERO-SHOT CLASSIFICATION
// ============================================

async function zeroShotClassify(text, labels) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({
            inputs: text,
            parameters: { candidate_labels: labels }
        });

        const url = new URL(HF_API_URL);
        const options = {
            hostname: url.hostname,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${HF_API_TOKEN}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        };

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(body);
                    if (result.error) {
                        console.error('HuggingFace API error:', result.error);
                        resolve(null);
                    } else {
                        resolve(result);
                    }
                } catch (e) {
                    console.error('Parse error:', e);
                    resolve(null);
                }
            });
        });

        req.on('error', (e) => {
            console.error('Request error:', e);
            resolve(null);
        });

        req.setTimeout(15000, () => {
            req.destroy();
            resolve(null);
        });

        req.write(data);
        req.end();
    });
}

// ============================================
// INTENT AGENT - Extracts user intent
// ============================================

async function intentAgent(userQuery) {
    console.log('🤖 Intent Agent: Processing query:', userQuery);
    
    const intent = {
        genre: null,
        genreScore: 0,
        mood: null,
        moodScore: 0,
        length: null,
        lengthScore: 0,
        budget: null,
        raw: userQuery
    };

    // Extract budget from query using simple pattern (allowed for numbers)
    const budgetMatch = userQuery.match(/(?:under|below|less than|within|budget|₹|rs\.?|rupees?)\s*(\d+)/i);
    if (budgetMatch) {
        intent.budget = parseInt(budgetMatch[1]);
    }

    // Zero-shot classification for genre
    const genreResult = await zeroShotClassify(userQuery, GENRE_LABELS);
    if (genreResult && genreResult.labels && genreResult.scores) {
        intent.genre = genreResult.labels[0];
        intent.genreScore = genreResult.scores[0];
        console.log(`   Genre detected: ${intent.genre} (${(intent.genreScore * 100).toFixed(1)}%)`);
    }

    // Zero-shot classification for mood
    const moodResult = await zeroShotClassify(userQuery, MOOD_LABELS);
    if (moodResult && moodResult.labels && moodResult.scores) {
        intent.mood = moodResult.labels[0];
        intent.moodScore = moodResult.scores[0];
        console.log(`   Mood detected: ${intent.mood} (${(intent.moodScore * 100).toFixed(1)}%)`);
    }

    // Zero-shot classification for length
    const lengthResult = await zeroShotClassify(userQuery, LENGTH_LABELS);
    if (lengthResult && lengthResult.labels && lengthResult.scores) {
        intent.length = lengthResult.labels[0];
        intent.lengthScore = lengthResult.scores[0];
        console.log(`   Length detected: ${intent.length} (${(intent.lengthScore * 100).toFixed(1)}%)`);
    }

    return intent;
}

// ============================================
// GENRE AGENT - Scores books by genre match
// ============================================

function genreAgent(book, intent) {
    if (!intent.genre) return 0.5; // Neutral if no genre intent

    const bookCategory = (book.category || '').toLowerCase();
    const bookDescription = (book.description || '').toLowerCase();
    const intentGenre = intent.genre.toLowerCase();

    // Direct category match
    if (bookCategory.includes(intentGenre)) {
        return 1.0;
    }

    // Check if genre appears in description
    if (bookDescription.includes(intentGenre)) {
        return 0.8;
    }

    // Partial matches for related genres
    const genreRelations = {
        'thriller': ['mystery', 'suspense', 'crime'],
        'mystery': ['thriller', 'detective', 'crime'],
        'romance': ['love', 'relationship'],
        'science fiction': ['sci-fi', 'space', 'future'],
        'fantasy': ['magic', 'mythical', 'supernatural'],
        'horror': ['scary', 'dark', 'supernatural'],
        'self-help': ['personal development', 'motivation', 'success'],
        'business': ['economics', 'finance', 'management', 'entrepreneurship'],
        'biography': ['memoir', 'autobiography', 'life story']
    };

    const related = genreRelations[intentGenre] || [];
    for (const rel of related) {
        if (bookCategory.includes(rel) || bookDescription.includes(rel)) {
            return 0.7;
        }
    }

    // No match
    return 0.3;
}

// ============================================
// MOOD AGENT - Scores books by emotional tone
// ============================================

function moodAgent(book, intent) {
    if (!intent.mood) return 0.5; // Neutral if no mood intent

    const bookDescription = (book.description || '').toLowerCase();
    const intentMood = intent.mood.toLowerCase();

    // Mood keywords mapping
    const moodKeywords = {
        'exciting': ['action', 'adventure', 'thrill', 'fast-paced', 'exciting'],
        'thrilling': ['suspense', 'tension', 'mystery', 'edge', 'gripping'],
        'relaxing': ['calm', 'peaceful', 'gentle', 'soothing', 'light'],
        'inspiring': ['inspire', 'motivation', 'success', 'overcome', 'achieve'],
        'thought-provoking': ['think', 'philosophical', 'deep', 'question', 'profound'],
        'funny': ['humor', 'comedy', 'laugh', 'funny', 'witty', 'hilarious'],
        'emotional': ['emotional', 'touching', 'heart', 'moving', 'tears'],
        'dark': ['dark', 'grim', 'bleak', 'twisted', 'sinister'],
        'uplifting': ['hope', 'positive', 'uplifting', 'joy', 'happy'],
        'adventurous': ['adventure', 'journey', 'explore', 'quest', 'discover'],
        'romantic': ['love', 'romance', 'passion', 'heart', 'relationship'],
        'mysterious': ['mystery', 'secret', 'hidden', 'unknown', 'enigma'],
        'educational': ['learn', 'knowledge', 'understand', 'teach', 'inform'],
        'motivational': ['motivate', 'inspire', 'success', 'achieve', 'goal'],
        'peaceful': ['peace', 'calm', 'serene', 'tranquil', 'quiet']
    };

    const keywords = moodKeywords[intentMood] || [intentMood];
    let matchCount = 0;

    for (const keyword of keywords) {
        if (bookDescription.includes(keyword)) {
            matchCount++;
        }
    }

    if (matchCount >= 3) return 1.0;
    if (matchCount >= 2) return 0.8;
    if (matchCount >= 1) return 0.6;
    return 0.4;
}

// ============================================
// LENGTH AGENT - Scores books by page count
// ============================================

function lengthAgent(book, intent) {
    if (!intent.length) return 0.5; // Neutral if no length intent

    const pageCount = book.page_count || 0;
    
    // If no page count, return neutral
    if (!pageCount) return 0.5;

    // Define length categories
    const isShort = pageCount <= 150;
    const isMedium = pageCount > 150 && pageCount <= 350;
    const isLong = pageCount > 350;

    const wantsShort = intent.length.includes('short');
    const wantsMedium = intent.length.includes('medium');
    const wantsLong = intent.length.includes('long');

    // Exact match
    if ((wantsShort && isShort) || (wantsMedium && isMedium) || (wantsLong && isLong)) {
        return 1.0;
    }

    // One category off
    if ((wantsShort && isMedium) || (wantsMedium && (isShort || isLong)) || (wantsLong && isMedium)) {
        return 0.6;
    }

    // Opposite ends
    return 0.3;
}

// ============================================
// HISTORY AGENT - Scores based on user history
// ============================================

async function historyAgent(book, userId) {
    if (!userId) return 0.5; // No boost for anonymous users

    try {
        // Get user's past purchases and searches
        const [purchases] = await pool.query(`
            SELECT DISTINCT b.category, b.author
            FROM orders o
            JOIN order_items oi ON o.id = oi.order_id
            JOIN books b ON oi.book_id = b.id
            WHERE o.user_id = ? AND o.payment_status = 'completed'
        `, [userId]);

        const [searches] = await pool.query(`
            SELECT detected_genre, detected_mood
            FROM user_search_history
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT 10
        `, [userId]);

        let score = 0.5; // Start neutral

        // Boost if book matches past purchase categories
        for (const purchase of purchases) {
            if (purchase.category && book.category && 
                purchase.category.toLowerCase() === book.category.toLowerCase()) {
                score += 0.2;
            }
            if (purchase.author && book.author &&
                purchase.author.toLowerCase() === book.author.toLowerCase()) {
                score += 0.15;
            }
        }

        // Small boost from search history
        for (const search of searches) {
            if (search.detected_genre && book.category &&
                book.category.toLowerCase().includes(search.detected_genre.toLowerCase())) {
                score += 0.05;
            }
        }

        // Cap at 1.0
        return Math.min(1.0, score);
    } catch (err) {
        console.error('History agent error:', err);
        return 0.5;
    }
}

// ============================================
// RECOMMENDATION AGENT - Orchestrates all agents
// ============================================

async function recommendationAgent(userQuery, userId) {
    console.log('\n🎯 Recommendation Agent: Starting...');
    
    // Step 1: Extract intent using Intent Agent
    const intent = await intentAgent(userQuery);
    
    if (!intent.genre && !intent.mood && !intent.length && !intent.budget) {
        console.log('   No clear intent detected, returning popular books');
        return { intent, recommendations: await getPopularBooks() };
    }

    // Step 2: Get all books from database
    const [books] = await pool.query(`
        SELECT id, title, author, description, price, stock, 
               page_count, category, image_url
        FROM books 
        WHERE stock > 0
    `);

    console.log(`   Found ${books.length} books to score`);

    // Step 3: Score each book using all sub-agents
    const scoredBooks = [];

    for (const book of books) {
        // Budget filter (hard filter, not scored)
        if (intent.budget && book.price > intent.budget) {
            continue;
        }

        // Get scores from each agent
        const genreScore = genreAgent(book, intent);
        const moodScore = moodAgent(book, intent);
        const lengthScore = lengthAgent(book, intent);
        const historyScore = await historyAgent(book, userId);

        // Calculate weighted final score
        const finalScore = 
            (genreScore * WEIGHTS.genre) +
            (moodScore * WEIGHTS.mood) +
            (lengthScore * WEIGHTS.length) +
            (historyScore * WEIGHTS.history);

        scoredBooks.push({
            ...book,
            scores: {
                genre: genreScore,
                mood: moodScore,
                length: lengthScore,
                history: historyScore,
                final: finalScore
            }
        });
    }

    // Step 4: Sort by final score (descending)
    scoredBooks.sort((a, b) => b.scores.final - a.scores.final);

    // Step 5: Return top 5 recommendations
    const recommendations = scoredBooks.slice(0, 5);

    console.log('   Top recommendations:');
    recommendations.forEach((book, i) => {
        console.log(`   ${i + 1}. ${book.title} (Score: ${book.scores.final.toFixed(2)})`);
    });

    return { intent, recommendations };
}

// Helper: Get popular books when no intent
async function getPopularBooks() {
    const [books] = await pool.query(`
        SELECT b.*, COUNT(oi.id) as order_count
        FROM books b
        LEFT JOIN order_items oi ON b.id = oi.book_id
        WHERE b.stock > 0
        GROUP BY b.id
        ORDER BY order_count DESC, b.created_at DESC
        LIMIT 5
    `);
    return books;
}

// ============================================
// API ROUTES
// ============================================

/**
 * POST /api/recommendations/chat
 * Main chat endpoint for recommendations
 */
router.post('/chat', auth, async (req, res) => {
    try {
        const { message } = req.body;
        const userId = req.user?.id;

        if (!message || message.trim().length < 3) {
            return res.status(400).json({ 
                message: 'Please provide a more detailed query' 
            });
        }

        console.log(`\n${'='.repeat(50)}`);
        console.log(`User ${userId} query: "${message}"`);
        console.log('='.repeat(50));

        // Get recommendations
        const { intent, recommendations } = await recommendationAgent(message, userId);

        // Log search for history agent (async, don't wait)
        logUserSearch(userId, message, intent).catch(console.error);

        // Format response
        const response = formatResponse(intent, recommendations);

        res.json({
            success: true,
            intent: {
                genre: intent.genre,
                mood: intent.mood,
                length: intent.length,
                budget: intent.budget
            },
            recommendations: recommendations.map(book => ({
                id: book.id,
                title: book.title,
                author: book.author,
                price: book.price,
                page_count: book.page_count,
                category: book.category,
                image_url: book.image_url,
                description: book.description?.substring(0, 200) + '...',
                scores: book.scores
            })),
            message: response
        });

    } catch (err) {
        console.error('Recommendation error:', err);
        res.status(500).json({ message: 'Failed to get recommendations' });
    }
});

/**
 * GET /api/recommendations/personalized
 * Get personalized recommendations for dashboard
 */
router.get('/personalized', auth, async (req, res) => {
    try {
        const userId = req.user.id;

        // Get user's purchase history categories
        const [history] = await pool.query(`
            SELECT DISTINCT b.category, b.author
            FROM orders o
            JOIN order_items oi ON o.id = oi.order_id
            JOIN books b ON oi.book_id = b.id
            WHERE o.user_id = ? AND o.payment_status = 'completed'
            LIMIT 5
        `, [userId]);

        if (history.length === 0) {
            // Cold start - return popular books
            const popular = await getPopularBooks();
            return res.json({
                type: 'popular',
                title: 'Popular Books',
                books: popular
            });
        }

        // Get books matching user's preferred categories/authors
        const categories = history.map(h => h.category).filter(Boolean);
        const authors = history.map(h => h.author).filter(Boolean);

        let query = `
            SELECT DISTINCT b.*
            FROM books b
            WHERE b.stock > 0
            AND b.id NOT IN (
                SELECT oi.book_id FROM order_items oi
                JOIN orders o ON oi.order_id = o.id
                WHERE o.user_id = ?
            )
        `;
        const params = [userId];

        if (categories.length > 0) {
            query += ` AND (b.category IN (${categories.map(() => '?').join(',')})`;
            params.push(...categories);
            
            if (authors.length > 0) {
                query += ` OR b.author IN (${authors.map(() => '?').join(',')})`;
                params.push(...authors);
            }
            query += ')';
        }

        query += ' ORDER BY b.created_at DESC LIMIT 10';

        const [books] = await pool.query(query, params);

        res.json({
            type: 'personalized',
            title: 'Recommended For You',
            books
        });

    } catch (err) {
        console.error('Personalized recommendations error:', err);
        res.status(500).json({ message: 'Failed to get recommendations' });
    }
});

/**
 * GET /api/recommendations/similar/:bookId
 * Get similar books
 */
router.get('/similar/:bookId', async (req, res) => {
    try {
        const { bookId } = req.params;

        // Get the source book
        const [sourceBooks] = await pool.query(
            'SELECT * FROM books WHERE id = ?', 
            [bookId]
        );

        if (sourceBooks.length === 0) {
            return res.status(404).json({ message: 'Book not found' });
        }

        const sourceBook = sourceBooks[0];

        // Find similar books by category and author
        const [similar] = await pool.query(`
            SELECT * FROM books
            WHERE id != ?
            AND stock > 0
            AND (
                category = ? 
                OR author = ?
                OR description LIKE ?
            )
            ORDER BY 
                CASE WHEN author = ? THEN 0 ELSE 1 END,
                CASE WHEN category = ? THEN 0 ELSE 1 END
            LIMIT 5
        `, [
            bookId,
            sourceBook.category,
            sourceBook.author,
            `%${sourceBook.title?.split(' ')[0]}%`,
            sourceBook.author,
            sourceBook.category
        ]);

        res.json({ books: similar });

    } catch (err) {
        console.error('Similar books error:', err);
        res.status(500).json({ message: 'Failed to get similar books' });
    }
});

// Helper: Log user search for history agent
async function logUserSearch(userId, query, intent) {
    if (!userId) return;

    try {
        await pool.query(`
            INSERT INTO user_search_history 
            (user_id, query, detected_genre, detected_mood, detected_length, created_at)
            VALUES (?, ?, ?, ?, ?, NOW())
        `, [
            userId,
            query,
            intent.genre || null,
            intent.mood || null,
            intent.length || null
        ]);
    } catch (err) {
        // Table might not exist yet, that's ok
        console.log('Search history logging skipped:', err.message);
    }
}

// Helper: Format response message
function formatResponse(intent, recommendations) {
    if (recommendations.length === 0) {
        return "I couldn't find any books matching your criteria. Try adjusting your preferences!";
    }

    let response = "Based on your preferences";
    const parts = [];

    if (intent.genre) parts.push(`**${intent.genre}** genre`);
    if (intent.mood) parts.push(`**${intent.mood}** mood`);
    if (intent.length) parts.push(`**${intent.length}**`);
    if (intent.budget) parts.push(`budget under **₹${intent.budget}**`);

    if (parts.length > 0) {
        response += ` (${parts.join(', ')})`;
    }

    response += `, here are my top ${recommendations.length} recommendations:`;

    return response;
}

module.exports = router;
