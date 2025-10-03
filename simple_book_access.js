// SIMPLE GIFT ACCESS FIX - Clean route
router.get('/:bookId/read', auth, async (req, res) => {
    try {
        const { bookId } = req.params;
        const userId = req.user.id;
        const userEmail = req.user.email;
        
        console.log(`Book access request: bookId=${bookId}, userId=${userId}, email=${userEmail}`);

        let bookAccess = null;

        // Check 1: Direct orders (purchase/rental)
        const [orders] = await pool.query(`
            SELECT o.*, oi.book_id, b.title, b.content_url, b.content_type, b.page_count, o.mode, o.rental_end
            FROM orders o
            JOIN order_items oi ON o.id = oi.order_id
            JOIN books b ON oi.book_id = b.id
            WHERE oi.book_id = ? AND o.user_id = ? AND o.payment_status = 'completed'
            ORDER BY o.created_at DESC
            LIMIT 1
        `, [bookId, userId]);

        if (orders.length > 0) {
            bookAccess = orders[0];
            console.log(`✅ DIRECT ORDER ACCESS GRANTED`);
        } else {
            // Check 2: Gifts (any gift for this user+book, regardless of claim status)
            const [gifts] = await pool.query(`
                SELECT g.*, b.title, b.content_url, b.content_type, b.page_count
                FROM gifts g
                JOIN books b ON g.book_id = b.id
                WHERE g.book_id = ? AND (g.recipient_user_id = ? OR g.recipient_email = ?)
                LIMIT 1
            `, [bookId, userId, userEmail]);

            if (gifts.length > 0) {
                bookAccess = {
                    ...gifts[0],
                    mode: 'purchase',
                    rental_end: null
                };
                console.log(`✅ GIFT ACCESS GRANTED`);
            }
        }

        if (!bookAccess) {
            console.log(`❌ ACCESS DENIED - No order or gift found`);
            return res.status(403).json({ 
                message: 'You do not have access to this book. Please purchase it or check if it was gifted to you.' 
            });
        }

        // Ensure book has content
        if (!bookAccess.content_url) {
            return res.status(404).json({ message: 'Book content not available yet.' });
        }

        // Check rental expiry
        if (bookAccess.mode === 'rent') {
            const now = new Date();
            const expiryDate = new Date(bookAccess.rental_end);
            if (now > expiryDate) {
                return res.status(403).json({ message: 'Your rental period has expired' });
            }
        }

        // Return access URL
        return res.json({
            readingUrl: bookAccess.content_url,
            contentType: bookAccess.content_type,
            title: bookAccess.title,
            pageCount: bookAccess.page_count,
            accessType: bookAccess.mode || 'purchase'
        });

    } catch (error) {
        console.error('Book access error:', error);
        res.status(500).json({ message: 'Failed to get book access' });
    }
});