USE sql12800178;



CREATE TABLE IF NOT EXISTS users (
		id INT PRIMARY KEY AUTO_INCREMENT,
		name VARCHAR(255) NOT NULL,
		email VARCHAR(255) NOT NULL UNIQUE,
		password VARCHAR(255) NOT NULL,
		phone VARCHAR(20),
		bio TEXT,
		profile_pic VARCHAR(512),
		created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
	);

	-- ================================
	-- Books
	-- ================================
	CREATE TABLE IF NOT EXISTS books (
		id VARCHAR(10) PRIMARY KEY,
		title VARCHAR(255) NOT NULL,
		author VARCHAR(255) NOT NULL,
		price DECIMAL(10, 2) NOT NULL,
		stock INT NOT NULL,
		description TEXT,
		cover VARCHAR(255),
		image_url VARCHAR(255),
		created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
	);

	-- ================================
	-- Addresses
	-- ================================
	CREATE TABLE IF NOT EXISTS addresses (
		id INT PRIMARY KEY AUTO_INCREMENT,
		user_id INT NOT NULL,
		label VARCHAR(50) NOT NULL,
		recipient VARCHAR(255) NOT NULL,
		street VARCHAR(255) NOT NULL,
		city VARCHAR(100) NOT NULL,
		state VARCHAR(100) NOT NULL,
		zip VARCHAR(20) NOT NULL,
		created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
		CONSTRAINT fk_addresses_user FOREIGN KEY (user_id)
			REFERENCES users(id)
			ON DELETE CASCADE ON UPDATE CASCADE
	);

	-- ================================
	-- Payment Cards
	-- ================================
	CREATE TABLE IF NOT EXISTS payment_cards (
		id INT PRIMARY KEY AUTO_INCREMENT,
		user_id INT NOT NULL,
		card_name VARCHAR(255) NOT NULL,
		card_number VARCHAR(25) NOT NULL,
		expiry VARCHAR(7) NOT NULL,
		cvv varchar(4),
		is_default BOOLEAN DEFAULT false,
		created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
		CONSTRAINT fk_cards_user FOREIGN KEY (user_id)
			REFERENCES users(id)
			ON DELETE CASCADE ON UPDATE CASCADE
	);

	-- ================================
	-- Orders
	-- ================================
	CREATE TABLE IF NOT EXISTS orders (
		id INT PRIMARY KEY AUTO_INCREMENT,
		user_id INT NOT NULL,
		mode ENUM('buy','rent','gift') NOT NULL,
		status VARCHAR(50) DEFAULT 'pending',
		total DECIMAL(10, 2) NOT NULL,
		shipping_address_id INT,
		payment_method VARCHAR(50),
		notes TEXT,
		rental_duration INT,
		rental_end DATETIME NULL,
		delivery_eta DATETIME NULL,
		gift_email VARCHAR(255),
		shipping_speed VARCHAR(50),
		created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
		-- Razorpay Integration Fields
		payment_status ENUM('pending', 'completed', 'failed', 'captured') DEFAULT 'pending',
		razorpay_order_id VARCHAR(100),
		razorpay_payment_id VARCHAR(100),
		razorpay_signature VARCHAR(200),
		updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
		CONSTRAINT fk_orders_user FOREIGN KEY (user_id)
			REFERENCES users(id)
			ON DELETE CASCADE ON UPDATE CASCADE,
		CONSTRAINT fk_orders_address FOREIGN KEY (shipping_address_id)
			REFERENCES addresses(id)
			ON DELETE SET NULL ON UPDATE CASCADE
	);

	-- ================================
	-- Order Items
	-- ================================
	CREATE TABLE IF NOT EXISTS order_items (
		id INT PRIMARY KEY AUTO_INCREMENT,
		order_id INT NOT NULL,
		book_id VARCHAR(10) NOT NULL,
		quantity INT NOT NULL,
		price DECIMAL(10, 2) NOT NULL,
		CONSTRAINT fk_items_order FOREIGN KEY (order_id)
			REFERENCES orders(id)
			ON DELETE CASCADE ON UPDATE CASCADE,
		CONSTRAINT fk_items_book FOREIGN KEY (book_id)
			REFERENCES books(id)
			ON DELETE RESTRICT ON UPDATE CASCADE
	);

	-- ================================
	-- Gifts
	-- ================================
	CREATE TABLE IF NOT EXISTS gifts (
	  id INT PRIMARY KEY AUTO_INCREMENT,
	  order_id INT NOT NULL,
	  book_id VARCHAR(10) NOT NULL,
	  quantity INT NOT NULL DEFAULT 1,
	  recipient_email VARCHAR(255) NOT NULL,
	  claim_token VARCHAR(64) NOT NULL,
	  recipient_user_id INT NULL,
	  read_at DATETIME NULL, -- When gift is claimed/read (replaces claimed_at)
	  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
	  UNIQUE KEY uq_gifts_token (claim_token),
	  KEY idx_gifts_email (recipient_email),
	  KEY idx_gifts_recipient (recipient_user_id),
	  CONSTRAINT fk_gifts_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
	  CONSTRAINT fk_gifts_book  FOREIGN KEY (book_id)  REFERENCES books(id)  ON DELETE RESTRICT,
	  CONSTRAINT fk_gifts_user  FOREIGN KEY (recipient_user_id) REFERENCES users(id) ON DELETE SET NULL
	);

	-- ================================
	-- Indexes
	-- ================================
	CREATE INDEX idx_books_title        ON books(title);
	CREATE INDEX idx_books_author       ON books(author);
	CREATE INDEX idx_addresses_user     ON addresses(user_id);
	CREATE INDEX idx_orders_user_date   ON orders(user_id, created_at);
	CREATE INDEX idx_items_order        ON order_items(order_id);

	-- ================================
	-- Views
	-- ================================
	CREATE OR REPLACE VIEW user_orders_details AS
	SELECT 
		u.id   AS user_id,
		u.name AS user_name,
		o.id   AS order_id,
		o.mode,
		o.payment_method,
		o.shipping_speed,
		o.status,
		o.created_at,
		o.gift_email,
		oi.book_id,
		b.title AS book_title,
		oi.quantity,
		oi.price,
		(oi.quantity * oi.price) AS line_total
	FROM users u
	JOIN orders o       ON o.user_id = u.id
	JOIN order_items oi ON oi.order_id = o.id
	JOIN books b        ON b.id = oi.book_id;

	-- ================================
	-- Sample Inserts (Books)
	-- ================================
	INSERT INTO books (id, title, author, price, stock, description, cover, image_url) VALUES
	('b1', 'The Pragmatic Programmer', 'Andrew Hunt', 599.00, 8, 'Timeless tips for pragmatic software development.', 'https://images.unsplash.com/photo-1524995997946-a1c2e315a42f', 'https://images.unsplash.com/photo-1524995997946-a1c2e315a42f'),
	('b2', 'Clean Code', 'Robert C. Martin', 549.00, 12, 'Principles of writing clean, maintainable software.', 'https://images.unsplash.com/photo-1516979187457-637abb4f9353', 'https://images.unsplash.com/photo-1516979187457-637abb4f9353'),
	('b3', 'Atomic Habits', 'James Clear', 399.00, 20, 'A framework for improving every day.', 'https://images.unsplash.com/photo-1544937950-fa07a98d237f', 'https://m.media-amazon.com/images/I/51-uspgqWIL._SX329_BO1,204,203,200_.jpg'),
	('b4', 'Thinking, Fast and Slow', 'Daniel Kahneman', 449.00, 9, 'Insights into how we think.', 'https://images.unsplash.com/photo-1543002588-bfa74002ed7e', 'https://covers.openlibrary.org/b/isbn/9780374275631-L.jpg'),
	('b5', 'Sapiens', 'Yuval Noah Harari', 499.00, 7, 'A brief history of humankind.', 'https://images.unsplash.com/photo-1526318472351-c75fcf070305', 'https://covers.openlibrary.org/b/isbn/9780062316097-L.jpg'),
	('b6', 'Ikigai', 'Héctor García', 299.00, 15, 'Discover your reason for being.', 'https://images.unsplash.com/photo-1507842217343-583bb7270b66', 'https://covers.openlibrary.org/b/isbn/9780143130727-L.jpg');

ALTER TABLE users MODIFY COLUMN password VARCHAR(255) NULL;
ALTER TABLE users ADD COLUMN is_admin TINYINT(1) NOT NULL DEFAULT 0;


ALTER TABLE orders
ADD COLUMN shipping_fee DECIMAL(10, 2),
ADD COLUMN cod_fee DECIMAL(10, 2);

UPDATE users SET is_admin = 1 WHERE email = 'admin@gmail.com';

ALTER TABLE gifts ADD COLUMN read_at DATETIME NULL AFTER claimed_at;
ALTER TABLE gifts DROP COLUMN claimed_at;

-- Add Razorpay payment tracking columns to orders table
ALTER TABLE orders ADD COLUMN payment_status ENUM('pending', 'completed', 'failed', 'captured') DEFAULT 'pending';
ALTER TABLE orders ADD COLUMN razorpay_order_id VARCHAR(100);
ALTER TABLE orders ADD COLUMN razorpay_payment_id VARCHAR(100);
ALTER TABLE orders ADD COLUMN razorpay_signature VARCHAR(200);
ALTER TABLE orders ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- Add Razorpay payment tracking columns to orders table
ALTER TABLE orders 
ADD COLUMN payment_status ENUM('pending', 'completed', 'failed', 'captured') DEFAULT 'pending' AFTER payment_method;

ALTER TABLE orders 
ADD COLUMN razorpay_order_id VARCHAR(100) AFTER payment_status;

ALTER TABLE orders 
ADD COLUMN razorpay_payment_id VARCHAR(100) AFTER razorpay_order_id;

ALTER TABLE orders 
ADD COLUMN razorpay_signature VARCHAR(200) AFTER razorpay_payment_id;

ALTER TABLE orders 

ADD COLUMN updated_at DATETIME DEFAULT NULL AFTER razorpay_signature;
-- ===============================================-- Add book content and sample storage columns
ALTER TABLE books ADD COLUMN content_url VARCHAR(512) NULL COMMENT 'Azure Blob Storage URL for book content';
ALTER TABLE books ADD COLUMN sample_url VARCHAR(512) NULL COMMENT 'Azure Blob Storage URL for book sample/preview';
ALTER TABLE books ADD COLUMN content_type ENUM('pdf', 'epub', 'txt', 'html') DEFAULT 'pdf' COMMENT 'Type of book content';
ALTER TABLE books ADD COLUMN page_count INT DEFAULT 0 COMMENT 'Number of pages in the book';


CREATE TABLE IF NOT EXISTS reading_sessions (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    book_id VARCHAR(50) NOT NULL,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMP NULL,
    pages_read INT DEFAULT 0,
    duration_minutes INT DEFAULT 0,
    session_type ENUM('purchase', 'rental', 'sample') DEFAULT 'purchase',
    created_at TIMESTAMP NULL,
    updated_at TIMESTAMP NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_user_book (user_id, book_id),
    INDEX idx_started_at (started_at)
);

-- 2. User Reading Stats Summary (for quick access)
CREATE TABLE IF NOT EXISTS user_reading_stats (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT UNIQUE NOT NULL,
    total_books_read INT DEFAULT 0,
    total_reading_minutes INT DEFAULT 0,
    total_pages_read INT DEFAULT 0,
    favorite_genre VARCHAR(100) NULL,
    last_reading_session TIMESTAMP NULL,
    books_completed INT DEFAULT 0,
    current_streak_days INT DEFAULT 0,
    longest_streak_days INT DEFAULT 0,
    created_at TIMESTAMP NULL,
    updated_at TIMESTAMP NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 3. Book Completion Tracking
CREATE TABLE IF NOT EXISTS book_completions (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    book_id VARCHAR(50) NOT NULL,
    completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    total_reading_time_minutes INT DEFAULT 0,
    rating INT NULL,
    created_at TIMESTAMP NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_user_book (user_id, book_id),
    INDEX idx_completed_at (completed_at)
);

-- 4. Daily Reading Activity (for streak calculation)
CREATE TABLE IF NOT EXISTS daily_reading_activity (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    reading_date DATE NOT NULL,
    pages_read_today INT DEFAULT 0,
    minutes_read_today INT DEFAULT 0,
    books_accessed_today INT DEFAULT 0,
    created_at TIMESTAMP NULL,
    updated_at TIMESTAMP NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_user_date (user_id, reading_date),
    INDEX idx_reading_date (reading_date)
);
