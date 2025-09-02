// Create services/TrendSelector.js
export class TrendSelector {
  constructor(db, trendAnalyzer) {
    this.db = db;
    this.trendAnalyzer = trendAnalyzer;
  }

  async getOptimalTrend() {
    const trends = await this.trendAnalyzer.getAggregatedTrends({
      sources: ['twitter', 'google', 'reddit'],
      limit: 20
    });
    
    const safeTrends = await this.trendAnalyzer.filterTrends(trends, {
      excludeControversial: true,
      minConfidence: 0.7
    });
    
    const recentlyUsed = await this.getRecentlyUsedTrends();
    
    // Select optimal trend with scoring
    const scoredTrends = safeTrends.map(trend => ({
      ...trend,
      score: this.calculateTrendScore(trend, recentlyUsed)
    }));
    
    // Sort by score and return best
    scoredTrends.sort((a, b) => b.score - a.score);
    return scoredTrends[0];
  }

  calculateTrendScore(trend, recentlyUsed) {
    let score = trend.confidence * 100;
    
    // Penalize if recently used
    if (recentlyUsed.includes(trend.topic)) {
      score *= 0.3;
    }
    
    // Boost if from multiple sources
    score += trend.sources.length * 10;
    
    // Boost if has supporting articles
    if (trend.articles && trend.articles.length > 0) {
      score += Math.min(trend.articles.length * 5, 25);
    }
    
    return score;
  }

  async getRecentlyUsedTrends(hours = 24) {
    // Implementation as shown above
  }

  async markAsUsed(trend) {
    // Implementation as shown above
  }
}