// publishers/MockPublisher.js
class MockPublisher {
  constructor(platform) {
    this.platform = platform;
  }

  async publishPost(content, mediaUrl = null) {
    console.log(`[MOCK] Publishing to ${this.platform}:`);
    console.log(`Content: ${content.substring(0, 100)}...`);
    console.log(`Media: ${mediaUrl || 'none'}`);
    
    return {
      success: true,
      platform: this.platform,
      postId: `mock_${Date.now()}`,
      url: `https://example.com/mock/${this.platform}`
    };
  }
}

export default MockPublisher;