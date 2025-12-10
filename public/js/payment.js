// payment.js - Payment page handling with Lemon Squeezy integration
document.addEventListener('DOMContentLoaded', () => {
    // Check if user is authenticated
    const token = localStorage.getItem('token');
    if (!token) {
        window.location.href = '/auth.html';
        return;
    }

    // Check for URL params (e.g., redirect back from checkout)
    const urlParams = new URLSearchParams(window.location.search);
    const plan = urlParams.get('plan');

    if (plan) {
        // Pre-select the plan if specified in URL
        highlightPlan(plan);
    }
});

// Highlight selected plan in UI
function highlightPlan(planId) {
    // Remove highlight from all plans
    document.querySelectorAll('.price-card').forEach(card => {
        card.classList.remove('ring-2', 'ring-purple-500');
    });

    // Add highlight to selected plan
    const selectedCard = document.querySelector(`[data-plan="${planId}"]`);
    if (selectedCard) {
        selectedCard.classList.add('ring-2', 'ring-purple-500');
    }
}

// Checkout function called by plan buttons
async function checkout(plan) {
    const token = localStorage.getItem('token');
    if (!token) {
        window.location.href = '/auth.html';
        return;
    }

    // Map frontend plan names to backend tier names if needed
    const tierMap = {
        'basic': 'starter',
        'starter': 'starter',
        'pro': 'growth',
        'growth': 'growth',
        'professional': 'professional',
        'enterprise': 'business',
        'business': 'business'
    };

    const tier = tierMap[plan.toLowerCase()] || plan.toLowerCase();

    // Show loading state
    const buttons = document.querySelectorAll('button');
    buttons.forEach(btn => {
        if (btn.textContent.includes('Get Started') || btn.textContent.includes('Select')) {
            btn.disabled = true;
            btn.innerHTML = '<span class="animate-pulse">Processing...</span>';
        }
    });

    // Check if test mode is enabled
    try {
        const testResponse = await fetch('/api/test/mode');
        if (testResponse.ok) {
            const testData = await testResponse.json();
            if (testData.testMode) {
                // Test mode: simulate successful payment
                if (confirm(`Test Mode: Simulate payment for ${tier} plan?`)) {
                    // Update user subscription in test mode
                    const subResponse = await fetch('/api/subscriptions/test-activate', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`
                        },
                        body: JSON.stringify({ tier: tier })
                    });

                    if (subResponse.ok) {
                        alert('Test payment successful! Redirecting to profile...');
                        setTimeout(() => {
                            window.location.href = '/profile.html?tab=subscription&payment=success';
                        }, 100);
                        return;
                    } else {
                        const error = await subResponse.json();
                        console.error('Subscription activation failed:', error);
                        alert('Failed to activate subscription: ' + (error.error || 'Unknown error'));
                        resetButtons();
                    }
                } else {
                    resetButtons();
                }
                return;
            }
        }
    } catch (error) {
        console.log('Could not check test mode, proceeding with live checkout');
    }

    // Production checkout flow - Lemon Squeezy
    try {
        const response = await fetch('/api/subscriptions/create-checkout', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ tier: tier })
        });

        const data = await response.json();

        if (response.ok && data.checkoutUrl) {
            // Redirect to Lemon Squeezy hosted checkout
            window.location.href = data.checkoutUrl;
        } else {
            console.error('Checkout error:', data);
            alert(data.error || 'Failed to create checkout session. Please try again.');
            resetButtons();
        }
    } catch (error) {
        console.error('Checkout error:', error);
        alert('An error occurred during checkout. Please try again.');
        resetButtons();
    }
}

// Reset buttons to original state
function resetButtons() {
    const buttons = document.querySelectorAll('button');
    buttons.forEach(btn => {
        btn.disabled = false;
        if (btn.innerHTML.includes('Processing')) {
            btn.innerHTML = 'Get Started';
        }
    });
}

// Subscribe function (alias for checkout, used in index.html)
function subscribe(plan) {
    checkout(plan);
}

// Make functions globally available
window.checkout = checkout;
window.subscribe = subscribe;
