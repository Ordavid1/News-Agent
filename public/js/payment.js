// payment.js - Payment page handling
document.addEventListener('DOMContentLoaded', () => {
    // Check if user is authenticated
    const token = localStorage.getItem('token');
    if (!token) {
        window.location.href = '/auth.html';
        return;
    }
});

// Checkout function called by plan buttons
async function checkout(plan) {
    const token = localStorage.getItem('token');
    if (!token) {
        window.location.href = '/auth.html';
        return;
    }

    // Check if test mode is enabled
    try {
        const testResponse = await fetch('/api/test/mode');
        if (testResponse.ok) {
            const testData = await testResponse.json();
            if (testData.testMode) {
                // Test mode: simulate successful payment
                if (confirm(`Test Mode: Simulate payment for ${plan} plan?`)) {
                    // Update user subscription in test mode
                    const subResponse = await fetch('/api/subscriptions/test-activate', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`
                        },
                        body: JSON.stringify({ tier: plan })
                    });

                    if (subResponse.ok) {
                        alert('Test payment successful! Redirecting to settings...');
                        // Small delay to ensure alert is seen before redirect
                        setTimeout(() => {
                            window.location.href = '/settings.html';
                        }, 100);
                        return;
                    } else {
                        // Show error if subscription activation failed
                        const error = await subResponse.json();
                        console.error('Subscription activation failed:', error);
                        alert('Failed to activate subscription: ' + (error.error || 'Unknown error'));
                    }
                }
                return;
            }
        }
    } catch (error) {
        console.log('Could not check test mode');
    }

    // Normal checkout flow
    const variantIds = {
        'basic': 'your-basic-plan-variant-id',
        'pro': 'your-pro-plan-variant-id',
        'enterprise': 'your-enterprise-plan-variant-id'
    };

    try {
        // Get checkout URL from your backend
        const response = await fetch('/api/subscriptions/create-checkout', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                plan: plan,
                variantId: variantIds[plan]
            })
        });

        const data = await response.json();

        if (response.ok && data.checkoutUrl) {
            // Redirect to LemonSqueezy checkout
            window.location.href = data.checkoutUrl;
        } else {
            alert(data.error || 'Failed to create checkout session');
        }
    } catch (error) {
        console.error('Checkout error:', error);
        alert('An error occurred during checkout');
    }
}

// Make checkout function globally available
window.checkout = checkout;