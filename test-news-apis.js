// test-news-apis.js
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const BASE_URL = 'http://localhost:3000/api/test';

const topics = ['ai', 'tech', 'crypto', 'startup'];

async function testNewsAPIs() {
  console.log('\n🔍 NEWS FETCHING VALIDATION\n');
  console.log('====================================\n');
  
  // 1. Check API configuration
  console.log('1. Checking API Configuration...');
  try {
    const configRes = await fetch(`${BASE_URL}/api-config`);
    const config = await configRes.json();
    console.log('\nAPI Configuration Status:');
    console.log(JSON.stringify(config, null, 2));
    
    // Check for real API keys
    const hasRealKeys = !config.config.newsapi.isMock || !config.config.gnews.isMock;
    if (!hasRealKeys) {
      console.log('\n⚠️  WARNING: All news APIs are using mock keys!');
      console.log('To fetch real news, please update your .env file with real API keys:');
      console.log('- NEWSAPI_KEY: Get from https://newsapi.org/');
      console.log('- GNEWS_API_KEY: Get from https://gnews.io/');
      console.log('- GOOGLE_CSE_API_KEY: Get from Google Cloud Console');
    }
  } catch (error) {
    console.error('Config check failed:', error.message);
  }
  
  console.log('\n====================================\n');
  
  // 2. Test each news source individually
  console.log('2. Testing Individual News Sources...\n');
  const sources = ['newsapi', 'gnews', 'google'];
  
  for (const source of sources) {
    console.log(`\nTesting ${source.toUpperCase()}:`);
    try {
      const res = await fetch(`${BASE_URL}/news-source/${source}/technology`);
      if (res.ok) {
        const data = await res.json();
        console.log(`✅ ${source}: Found ${data.count} articles`);
        if (data.results.length > 0) {
          console.log(`   Sample: "${data.results[0].title}"`);
        }
      } else {
        const error = await res.json();
        console.log(`❌ ${source}: ${error.error}`);
        if (error.details) {
          console.log(`   Details: ${JSON.stringify(error.details)}`);
        }
      }
    } catch (error) {
      console.log(`❌ ${source}: Network error - ${error.message}`);
    }
  }
  
  console.log('\n====================================\n');
  
  // 3. Test aggregated news fetching
  console.log('3. Testing Aggregated News Fetching...\n');
  
  for (const topic of topics) {
    console.log(`\nTesting topic: ${topic}`);
    try {
      const res = await fetch(`${BASE_URL}/news/${topic}?limit=5`);
      const data = await res.json();
      
      console.log(`Topic: ${topic}`);
      console.log(`Total results: ${data.totalResults}`);
      console.log(`Has real news: ${data.hasRealNews ? 'YES' : 'NO (using mock data)'}`);
      console.log(`Sources used: ${data.sources.join(', ')}`);
      
      if (data.news.length > 0) {
        console.log('\nTop news items:');
        data.news.slice(0, 3).forEach((item, i) => {
          console.log(`${i + 1}. ${item.title}`);
          console.log(`   Source: ${item.source.name} (${item.source.api})`);
        });
      }
    } catch (error) {
      console.error(`Failed to fetch news for ${topic}:`, error.message);
    }
  }
  
  console.log('\n====================================\n');
  
  // 4. Test trend analysis
  console.log('4. Testing Trend Analysis...\n');
  
  for (const topic of topics.slice(0, 2)) {
    console.log(`\nAnalyzing trends for: ${topic}`);
    try {
      const res = await fetch(`${BASE_URL}/trends/${topic}?limit=3`);
      const data = await res.json();
      
      console.log(`Trends found: ${data.trendsCount}`);
      console.log(`Has real trends: ${data.hasRealTrends ? 'YES' : 'NO'}`);
      
      if (data.trends.length > 0) {
        console.log('Top trends:');
        data.trends.forEach((trend, i) => {
          console.log(`${i + 1}. ${trend.title}`);
        });
      }
    } catch (error) {
      console.error(`Failed to analyze trends for ${topic}:`, error.message);
    }
  }
  
  console.log('\n====================================\n');
  
  // 5. Test complete pipeline
  console.log('5. Testing Complete Pipeline (News → Content Generation)...\n');
  
  const testPlatforms = [
    { platform: 'twitter', topic: 'ai' },
    { platform: 'linkedin', topic: 'tech' }
  ];
  
  for (const { platform, topic } of testPlatforms) {
    console.log(`\nTesting pipeline: ${topic} → ${platform}`);
    try {
      const res = await fetch(`${BASE_URL}/pipeline/${topic}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform, tone: 'professional' })
      });
      
      const data = await res.json();
      
      console.log(`Pipeline results:`);
      console.log(`- News found: ${data.pipeline.newsFound}`);
      console.log(`- Trends found: ${data.pipeline.trendsFound}`);
      console.log(`- Content generated: ${data.pipeline.contentGenerated ? 'YES' : 'NO'}`);
      
      if (data.generatedContent) {
        console.log(`\nGenerated ${platform} post:`);
        console.log(data.generatedContent.text.substring(0, 200) + '...');
      }
    } catch (error) {
      console.error(`Pipeline test failed:`, error.message);
    }
  }
  
  console.log('\n====================================\n');
  console.log('✅ NEWS VALIDATION COMPLETE\n');
  
  // Summary
  console.log('📋 SUMMARY:');
  console.log('1. Check your .env file for real API keys');
  console.log('2. NewsAPI: https://newsapi.org/register');
  console.log('3. GNews: https://gnews.io/register');
  console.log('4. Google CSE: https://developers.google.com/custom-search/v1/introduction');
  console.log('\nOnce you have real API keys, the app will fetch live news automatically!');
}

// Run tests
console.log('Starting News API validation...');
console.log('Make sure the server is running on port 3000\n');

testNewsAPIs().catch(console.error);