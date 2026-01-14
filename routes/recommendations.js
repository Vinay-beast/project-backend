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

// Genre categories for classification with keywords for fallback
const GENRE_LABELS = [
    'fiction', 'non-fiction', 'mystery', 'thriller', 'romance',
    'science fiction', 'fantasy', 'horror', 'biography', 'history',
    'self-help', 'business', 'economics', 'science', 'technology',
    'philosophy', 'psychology', 'education', 'travel', 'cooking',
    'art', 'music', 'sports', 'religion', 'politics', 'health'
];

// Genre keyword mapping for fallback detection
const GENRE_KEYWORDS = {
    'fiction': ['fiction', 'novel', 'story', 'stories', 'tale'],
    'non-fiction': ['non-fiction', 'nonfiction', 'real', 'true story', 'factual'],
    'mystery': ['mystery', 'detective', 'whodunit', 'crime', 'clues'],
    'thriller': ['thriller', 'suspense', 'action', 'spy', 'chase'],
    'romance': ['romance', 'love', 'romantic', 'relationship', 'dating'],
    'science fiction': ['sci-fi', 'science fiction', 'space', 'future', 'alien', 'robot'],
    'fantasy': ['fantasy', 'magic', 'wizard', 'dragon', 'mythical', 'supernatural'],
    'horror': ['horror', 'scary', 'ghost', 'haunted', 'creepy', 'terrifying'],
    'biography': ['biography', 'life story', 'memoir', 'autobiography'],
    'history': ['history', 'historical', 'ancient', 'war', 'civilization'],
    'self-help': ['self-help', 'self help', 'improvement', 'personal development', 'growth'],
    'business': ['business', 'startup', 'entrepreneur', 'company', 'corporate'],
    'economics': ['economics', 'economy', 'finance', 'money', 'market'],
    'science': ['science', 'scientific', 'physics', 'chemistry', 'biology'],
    'technology': ['technology', 'tech', 'computer', 'programming', 'coding', 'software'],
    'philosophy': ['philosophy', 'philosophical', 'thinking', 'wisdom', 'existential', 'stoic'],
    'psychology': ['psychology', 'mind', 'mental', 'behavior', 'cognitive'],
    'education': ['education', 'learning', 'study', 'academic', 'textbook'],
    'travel': ['travel', 'journey', 'adventure', 'explore', 'destination'],
    'cooking': ['cooking', 'recipe', 'food', 'cuisine', 'chef'],
    'art': ['art', 'artistic', 'painting', 'creative', 'design'],
    'music': ['music', 'musical', 'song', 'instrument', 'melody'],
    'sports': ['sports', 'athletic', 'fitness', 'game', 'player'],
    'religion': ['religion', 'religious', 'spiritual', 'faith', 'god'],
    'politics': ['politics', 'political', 'government', 'democracy', 'election'],
    'health': ['health', 'healthy', 'wellness', 'medical', 'fitness', 'diet']
};

// Mood/Feel categories
const MOOD_LABELS = [
    'exciting', 'thrilling', 'relaxing', 'inspiring', 'thought-provoking',
    'funny', 'emotional', 'dark', 'uplifting', 'adventurous',
    'romantic', 'mysterious', 'educational', 'motivational', 'peaceful'
];

// Mood keyword mapping for fallback
const MOOD_KEYWORDS = {
    'exciting': ['exciting', 'excitement', 'thrill', 'adrenaline', 'action-packed'],
    'thrilling': ['thrilling', 'suspenseful', 'tense', 'gripping', 'edge-of-seat'],
    'relaxing': ['relaxing', 'calm', 'peaceful', 'easy', 'light read', 'chill'],
    'inspiring': ['inspiring', 'inspiration', 'motivate', 'uplifting', 'encourage'],
    'thought-provoking': ['thought-provoking', 'think', 'deep', 'intellectual', 'philosophical'],
    'funny': ['funny', 'humor', 'comedy', 'hilarious', 'laugh', 'witty', 'comic'],
    'emotional': ['emotional', 'touching', 'heartfelt', 'moving', 'tearjerker', 'sad'],
    'dark': ['dark', 'grim', 'bleak', 'disturbing', 'twisted', 'noir'],
    'uplifting': ['uplifting', 'happy', 'joyful', 'positive', 'feel-good', 'heartwarming'],
    'adventurous': ['adventure', 'adventurous', 'journey', 'quest', 'exploration'],
    'romantic': ['romantic', 'love story', 'passionate', 'sweet', 'heartwarming'],
    'mysterious': ['mysterious', 'mystery', 'enigmatic', 'puzzling', 'intriguing'],
    'educational': ['educational', 'informative', 'learn', 'knowledge', 'insightful'],
    'motivational': ['motivational', 'motivate', 'inspire', 'success', 'achieve'],
    'peaceful': ['peaceful', 'serene', 'tranquil', 'meditative', 'zen']
};

// Length categories
const LENGTH_LABELS = ['short book', 'medium length book', 'long book'];

// Length keyword mapping for fallback
const LENGTH_KEYWORDS = {
    'short book': ['short', 'quick', 'brief', 'less than 100', 'less than 150', 'under 100', 'under 150', 'small', 'compact', 'few pages'],
    'medium length book': ['medium', 'moderate', 'average', 'normal length'],
    'long book': ['long', 'lengthy', 'detailed', 'comprehensive', 'epic', 'over 300', 'over 400', 'thick']
};

// ============================================
// HUGGINGFACE ZERO-SHOT CLASSIFICATION
// ============================================

async function zeroShotClassify(text, labels) {
    // Check if API token is available
    if (!HF_API_TOKEN) {
        console.log('⚠️ HuggingFace API token not configured, using fallback');
        return null;
    }

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
                    } else if (result.labels && result.scores) {
                        console.log('✅ HuggingFace API success');
                        resolve(result);
                    } else {
                        console.log('⚠️ Unexpected API response:', result);
                        resolve(null);
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
            console.log('⚠️ HuggingFace API timeout');
            req.destroy();
            resolve(null);
        });

        req.write(data);
        req.end();
    });
}

// ============================================
// FALLBACK KEYWORD-BASED CLASSIFICATION
// ============================================

function keywordClassify(text, keywordMap) {
    const lowerText = text.toLowerCase();
    let bestMatch = null;
    let bestScore = 0;
    let matchCount = 0;

    for (const [label, keywords] of Object.entries(keywordMap)) {
        let score = 0;
        let matches = 0;

        for (const keyword of keywords) {
            if (lowerText.includes(keyword.toLowerCase())) {
                // Exact word match gets higher score
                const wordRegex = new RegExp(`\\b${keyword}\\b`, 'i');
                if (wordRegex.test(lowerText)) {
                    score += 1.0;
                } else {
                    score += 0.5;
                }
                matches++;
            }
        }

        // Normalize by keyword count to get confidence
        const confidence = matches > 0 ? Math.min(0.95, score / keywords.length + (matches * 0.1)) : 0;

        if (confidence > bestScore) {
            bestScore = confidence;
            bestMatch = label;
            matchCount = matches;
        }
    }

    if (bestMatch && bestScore > 0.1) {
        return {
            labels: [bestMatch],
            scores: [bestScore],
            method: 'keyword'
        };
    }
    return null;
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
        raw: userQuery,
        method: 'none'
    };

    // Extract budget from query using simple pattern (allowed for numbers)
    const budgetMatch = userQuery.match(/(?:under|below|less than|within|budget|₹|rs\.?|rupees?)\s*(\d+)/i);
    if (budgetMatch) {
        intent.budget = parseInt(budgetMatch[1]);
        console.log(`   💰 Budget detected: ₹${intent.budget}`);
    }

    // Try HuggingFace API first, fall back to keyword matching
    let genreResult = await zeroShotClassify(userQuery, GENRE_LABELS);
    let moodResult = await zeroShotClassify(userQuery, MOOD_LABELS);
    let lengthResult = await zeroShotClassify(userQuery, LENGTH_LABELS);

    // If API failed, use keyword fallback
    if (!genreResult) {
        console.log('   📝 Using keyword fallback for genre');
        genreResult = keywordClassify(userQuery, GENRE_KEYWORDS);
    }
    if (!moodResult) {
        console.log('   📝 Using keyword fallback for mood');
        moodResult = keywordClassify(userQuery, MOOD_KEYWORDS);
    }
    if (!lengthResult) {
        console.log('   📝 Using keyword fallback for length');
        lengthResult = keywordClassify(userQuery, LENGTH_KEYWORDS);
    }

    // Process genre result
    if (genreResult && genreResult.labels && genreResult.scores) {
        intent.genre = genreResult.labels[0];
        intent.genreScore = genreResult.scores[0];
        intent.method = genreResult.method || 'api';
        console.log(`   🎭 Genre detected: ${intent.genre} (${(intent.genreScore * 100).toFixed(1)}%) [${genreResult.method || 'api'}]`);
    }

    // Process mood result
    if (moodResult && moodResult.labels && moodResult.scores) {
        intent.mood = moodResult.labels[0];
        intent.moodScore = moodResult.scores[0];
        console.log(`   💫 Mood detected: ${intent.mood} (${(intent.moodScore * 100).toFixed(1)}%) [${moodResult.method || 'api'}]`);
    }

    // Process length result
    if (lengthResult && lengthResult.labels && lengthResult.scores) {
        intent.length = lengthResult.labels[0];
        intent.lengthScore = lengthResult.scores[0];
        console.log(`   📄 Length detected: ${intent.length} (${(intent.lengthScore * 100).toFixed(1)}%) [${lengthResult.method || 'api'}]`);
    }

    // If still no intent detected, try broader keyword search
    if (!intent.genre && !intent.mood && !intent.length) {
        console.log('   🔍 No specific intent found, trying broader search...');
        // Check for any book-related keywords
        const lowerQuery = userQuery.toLowerCase();

        // Common genre-related words that might not be exact matches
        if (lowerQuery.includes('scary') || lowerQuery.includes('spooky')) {
            intent.genre = 'horror';
            intent.genreScore = 0.7;
        } else if (lowerQuery.includes('love') || lowerQuery.includes('romantic')) {
            intent.genre = 'romance';
            intent.genreScore = 0.7;
        } else if (lowerQuery.includes('learn') || lowerQuery.includes('study')) {
            intent.genre = 'education';
            intent.genreScore = 0.6;
        } else if (lowerQuery.includes('money') || lowerQuery.includes('invest')) {
            intent.genre = 'business';
            intent.genreScore = 0.6;
        } else if (lowerQuery.includes('life') || lowerQuery.includes('success')) {
            intent.genre = 'self-help';
            intent.genreScore = 0.5;
        }
    }

    console.log('   ✅ Intent extraction complete:', {
        genre: intent.genre,
        mood: intent.mood,
        length: intent.length,
        budget: intent.budget
    });

    return intent;
}

// ============================================
// GENRE AGENT - Scores books by genre match
// ============================================

function genreAgent(book, intent) {
    if (!intent.genre) return 0.5; // Neutral if no genre intent

    const bookCategory = (book.category || '').toLowerCase();
    const bookDescription = (book.description || '').toLowerCase();
    const bookTitle = (book.title || '').toLowerCase();
    const intentGenre = intent.genre.toLowerCase();

    // Direct category match
    if (bookCategory.includes(intentGenre) || bookCategory === intentGenre) {
        return 1.0;
    }

    // Check if genre appears in title
    if (bookTitle.includes(intentGenre)) {
        return 0.9;
    }

    // Check if genre appears in description
    if (bookDescription.includes(intentGenre)) {
        return 0.8;
    }

    // Partial matches for related genres
    const genreRelations = {
        'thriller': ['mystery', 'suspense', 'crime', 'action', 'spy'],
        'mystery': ['thriller', 'detective', 'crime', 'suspense'],
        'romance': ['love', 'relationship', 'romantic', 'dating'],
        'science fiction': ['sci-fi', 'space', 'future', 'technology', 'science'],
        'fantasy': ['magic', 'mythical', 'supernatural', 'wizard', 'dragon'],
        'horror': ['scary', 'dark', 'supernatural', 'ghost', 'creepy', 'terror'],
        'self-help': ['personal development', 'motivation', 'success', 'improvement', 'growth'],
        'business': ['economics', 'finance', 'management', 'entrepreneurship', 'startup', 'money'],
        'biography': ['memoir', 'autobiography', 'life story', 'history'],
        'philosophy': ['philosophical', 'thinking', 'wisdom', 'stoic', 'existential'],
        'psychology': ['mind', 'mental', 'behavior', 'cognitive', 'emotional'],
        'fiction': ['novel', 'story', 'literature', 'narrative'],
        'non-fiction': ['factual', 'real', 'true', 'informative'],
        'history': ['historical', 'ancient', 'war', 'civilization'],
        'education': ['learning', 'academic', 'study', 'textbook', 'guide']
    };

    const related = genreRelations[intentGenre] || [];
    for (const rel of related) {
        if (bookCategory.includes(rel) || bookDescription.includes(rel) || bookTitle.includes(rel)) {
            return 0.7;
        }
    }

    // Check if any GENRE_KEYWORDS match
    const keywords = GENRE_KEYWORDS[intentGenre] || [];
    for (const keyword of keywords) {
        if (bookDescription.includes(keyword) || bookTitle.includes(keyword)) {
            return 0.65;
        }
    }

    // No match - return low but not zero
    return 0.3;
}

// ============================================
// MOOD AGENT - Scores books by emotional tone
// ============================================

function moodAgent(book, intent) {
    if (!intent.mood) return 0.5; // Neutral if no mood intent

    const bookDescription = (book.description || '').toLowerCase();
    const bookTitle = (book.title || '').toLowerCase();
    const intentMood = intent.mood.toLowerCase();

    // Mood keywords mapping
    const moodKeywords = {
        'exciting': ['action', 'adventure', 'thrill', 'fast-paced', 'exciting', 'adrenaline'],
        'thrilling': ['suspense', 'tension', 'mystery', 'edge', 'gripping', 'intense'],
        'relaxing': ['calm', 'peaceful', 'gentle', 'soothing', 'light', 'easy'],
        'inspiring': ['inspire', 'motivation', 'success', 'overcome', 'achieve', 'dream'],
        'thought-provoking': ['think', 'philosophical', 'deep', 'question', 'profound', 'intellectual'],
        'funny': ['humor', 'comedy', 'laugh', 'funny', 'witty', 'hilarious', 'comic'],
        'emotional': ['emotional', 'touching', 'heart', 'moving', 'tears', 'feelings'],
        'dark': ['dark', 'grim', 'bleak', 'twisted', 'sinister', 'noir'],
        'uplifting': ['hope', 'positive', 'uplifting', 'joy', 'happy', 'heartwarming'],
        'adventurous': ['adventure', 'journey', 'explore', 'quest', 'discover', 'travel'],
        'romantic': ['love', 'romance', 'passion', 'heart', 'relationship', 'sweet'],
        'mysterious': ['mystery', 'secret', 'hidden', 'unknown', 'enigma', 'puzzle'],
        'educational': ['learn', 'knowledge', 'understand', 'teach', 'inform', 'guide'],
        'motivational': ['motivate', 'inspire', 'success', 'achieve', 'goal', 'growth'],
        'peaceful': ['peace', 'calm', 'serene', 'tranquil', 'quiet', 'meditative']
    };

    const keywords = moodKeywords[intentMood] || [intentMood];
    let matchCount = 0;
    let totalKeywords = keywords.length;

    for (const keyword of keywords) {
        if (bookDescription.includes(keyword) || bookTitle.includes(keyword)) {
            matchCount++;
        }
    }

    // More generous scoring
    if (matchCount >= 3) return 1.0;
    if (matchCount >= 2) return 0.85;
    if (matchCount >= 1) return 0.7;

    // Check for partial mood match based on category
    const categoryMoodMap = {
        'horror': ['dark', 'thrilling', 'mysterious'],
        'romance': ['romantic', 'emotional', 'uplifting'],
        'thriller': ['exciting', 'thrilling', 'mysterious'],
        'self-help': ['inspiring', 'motivational', 'uplifting'],
        'comedy': ['funny', 'uplifting'],
        'philosophy': ['thought-provoking', 'educational'],
        'adventure': ['exciting', 'adventurous']
    };

    const bookCategory = (book.category || '').toLowerCase();
    for (const [cat, moods] of Object.entries(categoryMoodMap)) {
        if (bookCategory.includes(cat) && moods.includes(intentMood)) {
            return 0.65;
        }
    }

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
        // Get user's past purchases
        const [purchases] = await pool.query(`
            SELECT DISTINCT b.category, b.author
            FROM orders o
            JOIN order_items oi ON o.id = oi.order_id
            JOIN books b ON oi.book_id = b.id
            WHERE o.user_id = ? AND o.payment_status = 'completed'
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

        // Try to get search history (table may not exist)
        try {
            const [searches] = await pool.query(`
                SELECT detected_genre, detected_mood
                FROM user_search_history
                WHERE user_id = ?
                ORDER BY created_at DESC
                LIMIT 10
            `, [userId]);

            // Small boost from search history
            for (const search of searches) {
                if (search.detected_genre && book.category &&
                    book.category.toLowerCase().includes(search.detected_genre.toLowerCase())) {
                    score += 0.05;
                }
            }
        } catch (searchErr) {
            // Search history table doesn't exist, that's ok
        }

        // Cap at 1.0
        return Math.min(1.0, score);
    } catch (err) {
        console.error('History agent error:', err.message);
        return 0.5;
    }
}

// ============================================
// RECOMMENDATION AGENT - Orchestrates all agents
// ============================================

async function recommendationAgent(userQuery, userId) {
    console.log('\n🎯 Recommendation Agent: Starting...');
    console.log(`   Query: "${userQuery}"`);
    console.log(`   User ID: ${userId || 'anonymous'}`);

    // Step 1: Extract intent using Intent Agent
    const intent = await intentAgent(userQuery);

    // Check if we have ANY intent
    const hasIntent = intent.genre || intent.mood || intent.length || intent.budget;

    if (!hasIntent) {
        console.log('   ⚠️ No clear intent detected, returning popular books');
        const popular = await getPopularBooks();
        // Give popular books a default score
        const scoredPopular = popular.map(book => ({
            ...book,
            scores: {
                genre: 0.5,
                mood: 0.5,
                length: 0.5,
                history: 0.5,
                final: 0.5
            }
        }));
        return { intent, recommendations: scoredPopular };
    }

    // Step 2: Get all books from database
    const [books] = await pool.query(`
        SELECT id, title, author, description, price, stock, 
               page_count, category, image_url
        FROM books 
        WHERE stock > 0
    `);

    console.log(`   📚 Found ${books.length} books to score`);

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
                genre: Math.round(genreScore * 100) / 100,
                mood: Math.round(moodScore * 100) / 100,
                length: Math.round(lengthScore * 100) / 100,
                history: Math.round(historyScore * 100) / 100,
                final: Math.round(finalScore * 100) / 100
            }
        });
    }

    console.log(`   ✅ Scored ${scoredBooks.length} books (after budget filter)`);

    // Step 4: Sort by final score (descending)
    scoredBooks.sort((a, b) => b.scores.final - a.scores.final);

    // Step 5: Return top 5 recommendations
    const recommendations = scoredBooks.slice(0, 5);

    console.log('   🏆 Top recommendations:');
    recommendations.forEach((book, i) => {
        console.log(`   ${i + 1}. "${book.title}" by ${book.author}`);
        console.log(`      Genre: ${book.scores.genre}, Mood: ${book.scores.mood}, Length: ${book.scores.length}, History: ${book.scores.history}`);
        console.log(`      Final Score: ${(book.scores.final * 100).toFixed(0)}%`);
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

    // Add default scores for popular books
    return books.map(book => ({
        ...book,
        scores: {
            genre: 0.5,
            mood: 0.5,
            length: 0.5,
            history: 0.5,
            final: 0.5
        }
    }));
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
        console.log(`🗣️ User ${userId || 'anonymous'} query: "${message}"`);
        console.log('='.repeat(50));

        // Get recommendations
        const { intent, recommendations } = await recommendationAgent(message, userId);

        // Log search for history agent (async, don't wait)
        logUserSearch(userId, message, intent).catch(console.error);

        // Format response
        const response = formatResponse(intent, recommendations);

        // Debug info
        console.log(`\n📤 Sending response with ${recommendations.length} recommendations`);
        if (recommendations.length > 0) {
            console.log(`   Top book: "${recommendations[0].title}" with score ${(recommendations[0].scores?.final * 100).toFixed(0)}%`);
        }

        res.json({
            success: true,
            intent: {
                genre: intent.genre,
                genreScore: intent.genreScore,
                mood: intent.mood,
                moodScore: intent.moodScore,
                length: intent.length,
                lengthScore: intent.lengthScore,
                budget: intent.budget,
                method: intent.method
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
            message: response,
            debug: {
                totalBooks: recommendations.length,
                apiTokenSet: !!HF_API_TOKEN,
                userId: userId || null
            }
        });

    } catch (err) {
        console.error('❌ Recommendation error:', err);
        res.status(500).json({
            message: 'Failed to get recommendations',
            error: err.message
        });
    }
});

/**
 * GET /api/recommendations/test
 * Debug endpoint to test the recommendation system
 */
router.get('/test', async (req, res) => {
    try {
        const testQuery = req.query.q || 'I want a philosophy book';

        console.log('\n🧪 TEST MODE: Testing recommendation system');
        console.log(`   Query: "${testQuery}"`);
        console.log(`   HF Token Set: ${!!HF_API_TOKEN}`);

        // Test intent extraction
        const intent = await intentAgent(testQuery);

        // Get sample books
        const [books] = await pool.query('SELECT * FROM books WHERE stock > 0 LIMIT 3');

        // Score sample books
        const sampleScores = books.map(book => ({
            title: book.title,
            category: book.category,
            genre: genreAgent(book, intent),
            mood: moodAgent(book, intent),
            length: lengthAgent(book, intent)
        }));

        res.json({
            status: 'ok',
            testQuery,
            intent: {
                genre: intent.genre,
                genreScore: intent.genreScore,
                mood: intent.mood,
                moodScore: intent.moodScore,
                length: intent.length,
                lengthScore: intent.lengthScore,
                method: intent.method
            },
            sampleScores,
            config: {
                huggingfaceTokenSet: !!HF_API_TOKEN,
                weights: WEIGHTS
            }
        });
    } catch (err) {
        res.status(500).json({
            status: 'error',
            error: err.message
        });
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
