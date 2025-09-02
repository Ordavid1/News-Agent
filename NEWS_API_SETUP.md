# News API Setup Guide

This guide will help you set up real news APIs for your News SAAS application.

## Overview

The application fetches real-time news from multiple sources:
- **NewsAPI**: Comprehensive news aggregation from 80,000+ sources
- **GNews API**: Global news coverage with advanced filtering
- **Google Custom Search**: Fallback option for specific searches

## Quick Setup

### 1. NewsAPI (Recommended)
1. Go to [https://newsapi.org/register](https://newsapi.org/register)
2. Sign up for a free account (1,000 requests/day)
3. Copy your API key
4. Update `.env`: `NEWSAPI_KEY=your-api-key-here`

### 2. GNews API
1. Visit [https://gnews.io/register](https://gnews.io/register)
2. Create a free account (100 requests/day)
3. Get your API token
4. Update `.env`: `GNEWS_API_KEY=your-token-here`

### 3. Google Custom Search (Optional)
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing
3. Enable "Custom Search API"
4. Create credentials (API Key)
5. Create a Custom Search Engine at [https://cse.google.com/](https://cse.google.com/)
6. Update `.env`:
   ```
   GOOGLE_CSE_API_KEY=your-google-api-key
   GOOGLE_CSE_ID=your-search-engine-id
   ```

## Testing Your Setup

### 1. Start the server:
```bash
npm start
```

### 2. Run the validation script:
```bash
node test-news-apis.js
```

### 3. Test individual endpoints:

#### Check API configuration:
```bash
curl http://localhost:3000/api/test/api-config
```

#### Test news fetching:
```bash
# Fetch AI news
curl http://localhost:3000/api/test/news/ai

# Fetch tech news
curl http://localhost:3000/api/test/news/technology

# Fetch crypto news
curl http://localhost:3000/api/test/news/crypto
```

#### Test specific news source:
```bash
# Test NewsAPI
curl http://localhost:3000/api/test/news-source/newsapi/technology

# Test GNews
curl http://localhost:3000/api/test/news-source/gnews/technology
```

#### Test complete pipeline:
```bash
# Generate Twitter post from tech news
curl -X POST http://localhost:3000/api/test/pipeline/technology \
  -H "Content-Type: application/json" \
  -d '{"platform": "twitter", "tone": "professional"}'

# Generate LinkedIn post from AI news
curl -X POST http://localhost:3000/api/test/pipeline/ai \
  -H "Content-Type: application/json" \
  -d '{"platform": "linkedin", "tone": "professional"}'
```

## API Limits

### Free Tier Limits:
- **NewsAPI**: 1,000 requests/day
- **GNews**: 100 requests/day
- **Google CSE**: 100 queries/day

### Paid Options:
- **NewsAPI**: Starting at $449/month for 250,000 requests
- **GNews**: Starting at $9/month for 10,000 requests
- **Google CSE**: $5 per 1,000 queries after free tier

## News Topics

The app supports these predefined topics with optimized search queries:
- `ai` - Artificial Intelligence, Machine Learning, Neural Networks
- `tech` - Technology, Software, Hardware, Gadgets
- `startup` - Startups, Entrepreneurship, Venture Capital
- `crypto` - Cryptocurrency, Bitcoin, Blockchain, Web3
- `productivity` - Productivity, Time Management, Automation
- `design` - UX/UI Design, Web Design, Graphic Design
- `business` - Business News, Strategy, Leadership
- `marketing` - Marketing, Advertising, Social Media

## Troubleshooting

### No news results?
1. Check if API keys are correctly set in `.env`
2. Verify API keys are active (not expired)
3. Check rate limits haven't been exceeded
4. Ensure topics are correctly formatted

### Rate limit errors?
- The app caches news for 30 minutes per topic
- Consider upgrading to paid tiers for production use
- Implement request queuing for high-volume usage

### Mock data appearing?
- This means real API keys are not configured
- The app falls back to mock data when APIs are unavailable
- Update `.env` with real API keys

## Production Recommendations

1. **Use multiple APIs**: Diversify sources to avoid single point of failure
2. **Implement caching**: Redis or similar for better performance
3. **Monitor usage**: Track API calls to avoid exceeding limits
4. **Error handling**: Graceful fallbacks when APIs are down
5. **Rate limiting**: Implement per-user limits to control costs

## Need Help?

Check the test results:
```bash
node test-news-apis.js
```

This will show:
- Current API configuration
- Which sources are working
- Sample news results
- Complete pipeline functionality