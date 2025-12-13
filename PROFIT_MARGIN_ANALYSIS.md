# News Agent SaaS - Profit Margin & Break-Even Analysis

## Cost Structure by Tier

### Fixed Costs

| Cost | Free | Starter | Growth+ |
|------|------|---------|---------|
| Render | $7 | $7 | $7 |
| GNews | $0 | $0 | $55 |
| Twitter API | $0 | $0 | $200 |
| WhatsApp | $0 | $0 | $20 |
| Google CSE | $0 | $0 | ~$5-15 |
| **Total Fixed** | **$7** | **$7** | **~$282-292** |

### Variable Costs (Per User)

**OpenAI (GPT-5-nano)**: ~500 tokens/post (~300 input + 200 output)
- Input: 300 × $0.05/1M = $0.000015
- Output: 200 × $0.40/1M = $0.00008
- **Per post: ~$0.0001**

**Lemon Squeezy**: 5% + $0.50 per transaction

---

## Tier-by-Tier Profit Analysis

### Free Tier (No Revenue)

| Item | Amount |
|------|--------|
| Posts | 1/week = 4/month |
| OpenAI cost | $0.0004/user/month |
| **Net** | **-$7 fixed cost** (loss leader) |

---

### Starter Tier ($49/mo)

| Item | Amount |
|------|--------|
| Revenue | $49.00 |
| Lemon Squeezy (5% + $0.50) | -$2.95 |
| OpenAI (300 posts × $0.0001) | -$0.03 |
| **Net per user** | **$46.02** |
| **Margin** | **93.9%** |

**Break-even**: $7 ÷ $46.02 = **1 user** (covers Render)

---

### Growth Tier ($149/mo)

| Item | Amount |
|------|--------|
| Revenue | $149.00 |
| Lemon Squeezy (5% + $0.50) | -$7.95 |
| OpenAI (600 posts × $0.0001) | -$0.06 |
| **Net per user** | **$140.99** |
| **Margin** | **94.6%** |

**Fixed costs at Growth**: $7 + $55 + $200 + $20 + $10 = **$292/mo**

**Break-even**: $292 ÷ $140.99 = **3 Growth users** (or mix below)

---

### Professional Tier ($399/mo)

| Item | Amount |
|------|--------|
| Revenue | $399.00 |
| Lemon Squeezy (5% + $0.50) | -$20.45 |
| OpenAI (900 posts × $0.0001) | -$0.09 |
| **Net per user** | **$378.46** |
| **Margin** | **94.9%** |

---

### Business Tier ($799/mo)

| Item | Amount |
|------|--------|
| Revenue | $799.00 |
| Lemon Squeezy (5% + $0.50) | -$40.45 |
| OpenAI (1,350 posts × $0.0001) | -$0.14 |
| **Net per user** | **$758.41** |
| **Margin** | **94.9%** |

---

## Break-Even Scenarios

### Phase 1: Starter Only (No Twitter/GNews)

**Fixed cost**: $7/mo

| Users | Revenue | Costs | Profit |
|-------|---------|-------|--------|
| 1 Starter | $49 | $7 + $2.98 | **+$39.02** |

**Break-even: 1 Starter user**

---

### Phase 2: Growth+ (With Twitter/GNews/WhatsApp)

**Fixed cost**: $292/mo

| Mix | Revenue | Variable | Fixed | Profit |
|-----|---------|----------|-------|--------|
| 7 Starter | $343 | $20.86 | $292 | **+$30.14** |
| 3 Growth | $447 | $23.85 | $292 | **+$131.15** |
| 1 Pro | $399 | $20.54 | $292 | **+$86.46** |
| 5 Starter + 1 Growth | $394 | $22.80 | $292 | **+$79.20** |

**Break-even: ~7 Starter OR 3 Growth OR 1 Professional**

---

## Summary Table

| Tier | Price | Net/User | Margin | Break-Even (Phase 1) | Break-Even (Phase 2) |
|------|-------|----------|--------|---------------------|---------------------|
| **Free** | $0 | -$0.0004 | N/A | N/A | N/A |
| **Starter** | $49 | $46.02 | 93.9% | 1 user | 7 users |
| **Growth** | $149 | $140.99 | 94.6% | 1 user | 3 users |
| **Professional** | $399 | $378.46 | 94.9% | 1 user | 1 user |
| **Business** | $799 | $758.41 | 94.9% | 1 user | 1 user |

---

## Recommended Strategy

| Stage | Fixed Costs | Trigger to Move Up |
|-------|-------------|-------------------|
| **Phase 1** | $7/mo (Render only) | Stay until you have Growth subscribers |
| **Phase 2** | $292/mo (add Twitter, GNews, WhatsApp) | Activate when you get first Growth user |

**Why?** Growth tier enables Twitter - so you only pay for Twitter API ($200) when you have Growth+ users who need it. With just 3 Growth users, you're profitable on the $292/mo infrastructure.

---

## Pricing Tiers Features

| Feature | Free | Starter | Growth | Professional | Business |
|---------|------|---------|--------|--------------|----------|
| **Price** | $0 | $49/mo | $149/mo | $399/mo | $799/mo |
| **Posts** | 1/week | 10/day | 20/day | 30/day | 45/day |
| **Agents** | 1 | 2 | 5 | 10 | Unlimited |
| **Platforms** | 3 | 3 | 4 | 5 | 7 |
| LinkedIn | ✅ | ✅ | ✅ | ✅ | ✅ |
| Reddit | ✅ | ✅ | ✅ | ✅ | ✅ |
| Telegram | ✅ | ✅ | ✅ | ✅ | ✅ |
| Twitter | ❌ | ❌ | ✅ | ✅ | ✅ |
| Instagram | ❌ | ❌ | ❌ | ✅ | ✅ |
| TikTok | ❌ | ❌ | ❌ | ❌ | ✅ |
| YouTube | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Scheduling** | ❌ | ❌ | ✅ | ✅ | ✅ |
| **Bulk Generate** | ❌ | ❌ | ❌ | ✅ | ✅ |
| **Analytics** | ❌ | ❌ | ✅ | ✅ | ✅ |
| **Export** | ❌ | ❌ | ❌ | ❌ | ✅ |

---

## Assumptions

1. **Render hosting**: $7/month
2. **OpenAI GPT-5-nano**: $0.05/1M input, $0.40/1M output
3. **Lemon Squeezy**: 5% + $0.50 per transaction
4. **GNews Essential**: $55/month (€50) - only for Growth+
5. **Twitter Basic API**: $200/month - only for Growth+
6. **WhatsApp infra**: $20/month - only for Growth+
7. **Google CSE**: ~$5-15/month based on usage - only for Growth+
8. **NewsAPI**: Not used (will upscale GNews if needed)

---

*Last updated: December 2024*
