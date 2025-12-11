# AIPostGen SaaS Platform

A modern SaaS platform for AI-powered social media post generation with subscription tiers, multi-tenant support, and a vibrant Gen-Z aesthetic.

## Features

- 🚀 **Multi-tier Subscription Model**
  - Free: 1 post/week
  - Starter: 10 posts/day ($49/month)
  - Growth: 20 posts/day ($149/month)
  - Professional: 30 posts/day ($399/month)
  - Business: 45 posts/day ($799/month)

- 🎨 **Modern Gen-Z UI**
  - Neon glow effects
  - Gradient animations
  - Dark theme with vibrant accents
  - Responsive design

- 🔧 **Technical Features**
  - Multi-tenant architecture
  - Stripe payment integration
  - JWT authentication
  - Rate limiting per tier
  - API access for higher tiers
  - Analytics dashboard

## Setup Instructions

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Configure Environment**
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

3. **Set up Stripe**
   - Create a Stripe account
   - Add your secret key to .env
   - Set up webhook endpoint for `/api/subscriptions/webhook`

4. **Start the Server**
   ```bash
   npm run dev
   ```

5. **Build CSS (in another terminal)**
   ```bash
   npm run build:css
   ```

## Architecture

### Backend Structure
- `server.js` - Main Express server
- `routes/` - API endpoints
  - `auth.js` - Authentication endpoints
  - `posts.js` - Post generation endpoints
  - `subscriptions.js` - Stripe integration
  - `analytics.js` - User analytics
  - `users.js` - User management
- `middleware/` - Express middleware
  - `auth.js` - JWT authentication
  - `subscription.js` - Tier verification
  - `rateLimiter.js` - Rate limiting
- `services/` - Business logic
  - `database.js` - Firestore integration

### Frontend Structure
- `public/` - Static files
  - `index.html` - Landing page
  - `dashboard.html` - User dashboard
  - `js/` - JavaScript files
  - `styles/` - CSS files

## API Endpoints

### Authentication
- `POST /api/auth/register` - Create new account
- `POST /api/auth/login` - Login
- `POST /api/auth/forgot-password` - Request password reset
- `POST /api/auth/reset-password` - Reset password

### Posts
- `POST /api/posts/generate` - Generate new post
- `GET /api/posts` - Get user's posts
- `POST /api/posts/:id/schedule` - Schedule post (Growth+)
- `POST /api/posts/bulk-generate` - Bulk generation (Professional+)

### Subscriptions
- `GET /api/subscriptions/current` - Get current subscription
- `POST /api/subscriptions/create-checkout` - Create Stripe checkout
- `POST /api/subscriptions/cancel` - Cancel subscription
- `POST /api/subscriptions/webhook` - Stripe webhook handler

### Analytics
- `GET /api/analytics/overview` - Basic analytics
- `GET /api/analytics/usage` - Detailed usage (Growth+)
- `GET /api/analytics/performance` - Performance metrics (Professional+)
- `GET /api/analytics/export` - Export data (Business only)

## Platform Availability by Tier

- **Free**: Twitter only
- **Starter**: Twitter, LinkedIn
- **Growth**: Twitter, LinkedIn, Reddit
- **Professional**: Twitter, LinkedIn, Reddit, Facebook, Instagram
- **Business**: All platforms including TikTok and YouTube

## Development

### Running in Development
```bash
npm run dev
```

### Building for Production
```bash
npm start
```

## Integration with Parent Bot

The SaaS platform integrates with the parent bot by:
1. Calling the `/generate` endpoint on the parent bot
2. Using a prefixed userId (`saas-{userId}`) to track usage
3. Running on a different port (default: 3000)

## Security

- JWT tokens for authentication
- Rate limiting based on subscription tier
- Secure Stripe webhook validation
- Input validation and sanitization
- CORS configuration for frontend

## Future Enhancements

- [ ] Email notifications
- [ ] Team accounts
- [ ] Custom branding (white-label)
- [ ] Webhook integrations
- [ ] Mobile app
- [ ] Advanced scheduling features
- [ ] Content templates
- [ ] A/B testing