// affiliate.js - AE Affiliate dashboard logic (embedded in profile.html)
//
// Shared variables (csrfToken, currentUser) and CSRF functions are provided
// by profile.js. Affiliate init is triggered via the showTab wrapper in
// profile.html when the Affiliate tab is shown.

// Affiliate-specific state
var affiliateAddon = null;
var affiliateCredentials = null;
var affiliateKeywords = [];
var affiliateHistory = [];
var affiliateStats = null;

// ============================================
// INITIALIZATION
// ============================================

async function initAffiliate() {
    const hasAddon = await checkAffiliateAddon();

    if (hasAddon) {
        // Load credentials status, keywords, and categories in parallel
        await Promise.all([
            loadCredentialStatus(),
            loadKeywords(),
            loadCategories()
        ]);
    }
}

// ============================================
// AFFILIATE ADDON CHECK
// ============================================

async function checkAffiliateAddon() {
    const token = localStorage.getItem('token');
    try {
        const response = await fetch('/api/subscriptions/affiliate-addon', {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (response.ok) {
            const data = await response.json();
            if (data.addon && data.addon.status === 'active') {
                affiliateAddon = data.addon;

                // Hide purchase banner, show active content
                const requiredBanner = document.getElementById('affiliateAddonRequiredBanner');
                const activeContent = document.getElementById('affiliateActiveContent');
                if (requiredBanner) requiredBanner.classList.add('hidden');
                if (activeContent) activeContent.classList.remove('hidden');

                return true;
            }
        }
    } catch (error) {
        console.error('Error checking affiliate addon:', error);
    }

    // Show purchase banner, hide active content
    const requiredBanner = document.getElementById('affiliateAddonRequiredBanner');
    const activeContent = document.getElementById('affiliateActiveContent');
    if (requiredBanner) requiredBanner.classList.remove('hidden');
    if (activeContent) activeContent.classList.add('hidden');
    return false;
}

// ============================================
// ADDON PURCHASE / CANCEL
// ============================================

async function purchaseAffiliateAddon() {
    const btn = document.getElementById('affiliatePurchaseBtn');
    const originalHtml = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<div class="loader" style="width:16px;height:16px;"></div> Preparing...';
    }

    try {
        const { checkoutUrl } = await affApiPost('/api/subscriptions/affiliate-checkout');

        if (btn) btn.innerHTML = '<div class="loader" style="width:16px;height:16px;"></div> Pay $9/mo...';
        const paid = await showCompactCheckout(checkoutUrl, btn || document.getElementById('affiliateAddonRequiredBanner'), { direction: 'down' });

        if (!paid) {
            if (btn) { btn.disabled = false; btn.innerHTML = originalHtml; }
            return;
        }

        // Poll for webhook confirmation
        if (btn) btn.innerHTML = '<div class="loader" style="width:16px;height:16px;"></div> Activating...';
        let activated = false;
        for (let attempt = 0; attempt < 15; attempt++) {
            await new Promise(r => setTimeout(r, 2000));
            try {
                activated = await checkAffiliateAddon();
                if (activated) break;
            } catch (e) { /* continue polling */ }
        }

        if (!activated) {
            showToast('Payment received but activation pending. Please refresh in a moment.', 'warning');
            if (btn) { btn.disabled = false; btn.innerHTML = originalHtml; }
            return;
        }

        showToast('AE Affiliate add-on activated successfully!', 'success');
        await Promise.all([loadCredentialStatus(), loadKeywords()]);

    } catch (error) {
        showToast(error.message || 'Payment failed. Please try again.', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = originalHtml; }
    }
}

async function openAffiliatePortal() {
    const token = localStorage.getItem('token');
    try {
        const response = await fetch('/api/subscriptions/affiliate-portal', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (response.ok) {
            const data = await response.json();
            if (data.portalUrl) {
                window.open(data.portalUrl, '_blank');
            }
        } else {
            showToast('Unable to open billing portal', 'error');
        }
    } catch (error) {
        showToast('Network error. Please try again.', 'error');
    }
}

async function cancelAffiliateAddon() {
    if (!confirm('Are you sure you want to cancel your AE Affiliate add-on? You will lose access to all affiliate features at the end of your current billing period.')) {
        return;
    }

    const btn = document.getElementById('cancelAffiliateAddonBtn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Cancelling...';
    }

    try {
        const response = await fetch('/api/subscriptions/affiliate-cancel', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('token')}`,
                'Content-Type': 'application/json',
                'X-CSRF-Token': getCsrfToken()
            }
        });

        if (response.ok) {
            showToast('AE Affiliate add-on cancelled. Access continues until end of billing period.', 'success');
            await checkAffiliateAddon();
        } else {
            const data = await response.json();
            showToast(data.error || 'Failed to cancel. Please try again.', 'error');
        }
    } catch (error) {
        showToast('Failed to cancel. Please try again.', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Cancel Subscription'; }
    }
}

// ============================================
// CREDENTIAL MANAGEMENT
// ============================================

async function loadCredentialStatus() {
    try {
        const data = await affApiGet('/api/affiliate/credentials/status');
        affiliateCredentials = data;
        renderCredentialStatus(data);
    } catch (error) {
        // No credentials yet - show setup form
        renderCredentialStatus({ configured: false });
    }
}

function renderCredentialStatus(status) {
    const container = document.getElementById('credentialStatusContainer');
    if (!container) return;

    if (status.oauthConnected && status.trackingId) {
        // State 3: OAuth connected + tracking ID set
        container.innerHTML = `
            <div class="flex items-center justify-between p-4 rounded-xl bg-green-50 border border-green-200">
                <div class="flex items-center gap-3">
                    <div class="w-9 h-9 rounded-full bg-green-100 flex items-center justify-center">
                        <svg class="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                        </svg>
                    </div>
                    <div>
                        <p class="font-medium text-green-800">AliExpress Account Connected</p>
                        <p class="text-sm text-green-600">
                            ${status.oauthUsername ? escapeHtml(status.oauthUsername) + ' &middot; ' : ''}Tracking ID: ${escapeHtml(status.trackingId)}
                        </p>
                    </div>
                </div>
                <div class="flex items-center gap-2">
                    <button onclick="toggleCredentialForm()" class="text-sm text-ink-500 hover:text-ink-700 border border-ink-300 rounded-lg px-3 py-1.5 transition-colors">
                        Edit Tracking ID
                    </button>
                    <button onclick="disconnectAliExpress()" class="text-sm text-red-500 hover:text-red-700 border border-red-300 rounded-lg px-3 py-1.5 transition-colors">
                        Disconnect
                    </button>
                </div>
            </div>
            <div id="credentialFormWrapper" class="hidden mt-4">
                ${getTrackingIdFormHtml()}
            </div>
        `;
    } else if (status.oauthConnected) {
        // State 2: OAuth connected, no tracking ID
        container.innerHTML = `
            <div class="flex items-center justify-between p-4 rounded-xl bg-green-50 border border-green-200">
                <div class="flex items-center gap-3">
                    <div class="w-9 h-9 rounded-full bg-green-100 flex items-center justify-center">
                        <svg class="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                        </svg>
                    </div>
                    <div>
                        <p class="font-medium text-green-800">AliExpress Account Connected</p>
                        <p class="text-sm text-green-600">
                            ${status.oauthUsername ? escapeHtml(status.oauthUsername) : 'Account linked'}
                        </p>
                    </div>
                </div>
                <div class="flex items-center gap-2">
                    <button onclick="toggleCredentialForm()" class="text-sm text-ink-500 hover:text-ink-700 border border-ink-300 rounded-lg px-3 py-1.5 transition-colors">
                        Set Tracking ID
                    </button>
                    <button onclick="disconnectAliExpress()" class="text-sm text-red-500 hover:text-red-700 border border-red-300 rounded-lg px-3 py-1.5 transition-colors">
                        Disconnect
                    </button>
                </div>
            </div>
            <div id="credentialFormWrapper" class="hidden mt-4">
                <p class="text-xs text-ink-400 mb-3">Tracking ID is optional. It adds a sub-label for analytics in your AliExpress Portals dashboard.</p>
                ${getTrackingIdFormHtml()}
            </div>
        `;
    } else {
        // State 1: Not connected — show connect button
        container.innerHTML = `
            <div class="p-4 rounded-xl bg-amber-50 border border-amber-200">
                <div class="flex items-center gap-3 mb-3">
                    <div class="w-9 h-9 rounded-full bg-amber-100 flex items-center justify-center">
                        <svg class="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"></path>
                        </svg>
                    </div>
                    <div>
                        <p class="font-medium text-amber-800">Connect Your AliExpress Account</p>
                        <p class="text-sm text-amber-600">Link your AliExpress account to start generating commission-earning affiliate links.</p>
                    </div>
                </div>
                <button onclick="connectAliExpress()" class="btn-primary btn-sm">
                    Connect AliExpress Account
                </button>
            </div>
        `;
    }
}

function getTrackingIdFormHtml() {
    return `
        <div class="space-y-4" id="credentialForm">
            <div>
                <label class="block text-sm font-medium text-ink-600 mb-1">Tracking ID</label>
                <input type="text" id="affTrackingId" class="input-field" placeholder="e.g. my_telegram_bot">
                <p class="text-xs text-ink-400 mt-1">Your affiliate tracking ID. Found in <a href="https://portals.aliexpress.com" target="_blank" class="text-brand-600 hover:underline">AliExpress Portals</a> &rarr; Account &rarr; Tracking ID.</p>
            </div>
            <div class="flex gap-3">
                <button onclick="saveCredentials()" id="saveCredentialsBtn" class="btn-primary btn-sm">
                    Save Tracking ID
                </button>
            </div>
        </div>
    `;
}

function toggleCredentialForm() {
    const wrapper = document.getElementById('credentialFormWrapper');
    if (wrapper) {
        wrapper.classList.toggle('hidden');
    }
}

async function saveCredentials() {
    const trackingId = document.getElementById('affTrackingId')?.value?.trim();

    if (!trackingId) {
        showToast('Please enter a Tracking ID.', 'error');
        return;
    }

    const btn = document.getElementById('saveCredentialsBtn');
    const originalHtml = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<div class="loader" style="width:16px;height:16px;"></div> Saving...';
    }

    try {
        await affApiPost('/api/affiliate/credentials', { trackingId });
        showToast('Tracking ID saved!', 'success');
        await loadCredentialStatus();
    } catch (error) {
        showToast(error.message || 'Failed to save tracking ID.', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = originalHtml; }
    }
}

async function removeTrackingId() {
    if (!confirm('Remove your tracking ID? Your affiliate links will still work but without sub-tracking.')) {
        return;
    }

    try {
        await affApiDelete('/api/affiliate/credentials');
        showToast('Tracking ID removed.', 'success');
        await loadCredentialStatus();
    } catch (error) {
        showToast('Failed to remove tracking ID.', 'error');
    }
}

// Legacy alias
async function deleteCredentials() { await removeTrackingId(); }

async function connectAliExpress() {
    // Uses the shared connectPlatform from profile.js which handles OAuth redirect
    connectPlatform('aliexpress');
}

async function disconnectAliExpress() {
    if (!confirm('Disconnect your AliExpress account? Affiliate product search and link generation will stop working.')) {
        return;
    }
    try {
        // Delete OAuth connection
        const token = localStorage.getItem('token');
        await fetch('/api/connections/aliexpress', {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${token}`,
                'X-CSRF-Token': getCsrfToken()
            }
        });
        // Also clean up tracking ID from affiliate_credentials
        try { await affApiDelete('/api/affiliate/credentials'); } catch { /* may not exist */ }
        showToast('AliExpress account disconnected.', 'success');
        await loadCredentialStatus();
    } catch (error) {
        showToast('Failed to disconnect. Please try again.', 'error');
    }
}

// ============================================
// KEYWORD MANAGEMENT
// ============================================

async function loadKeywords() {
    try {
        const data = await affApiGet('/api/affiliate/keywords');
        affiliateKeywords = data.keywords || [];
        renderKeywords();
    } catch (error) {
        console.error('Error loading keywords:', error);
        affiliateKeywords = [];
        renderKeywords();
    }
}

function renderKeywords() {
    const container = document.getElementById('keywordsContainer');
    if (!container) return;

    if (affiliateKeywords.length === 0) {
        container.innerHTML = `
            <div class="text-center py-8 text-ink-400">
                <svg class="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"></path>
                </svg>
                <p class="font-medium mb-1">No keyword sets yet</p>
                <p class="text-sm">Create keyword sets to define which products to search for.</p>
            </div>
        `;
        return;
    }

    container.innerHTML = affiliateKeywords.map(kw => `
        <div class="card-gradient p-4 rounded-xl mb-3" data-keyword-id="${kw.id}">
            <div class="flex items-center justify-between mb-2">
                <div class="flex items-center gap-2">
                    <h4 class="font-medium text-ink-800">${escapeHtml(kw.name || 'Unnamed Set')}</h4>
                    <span class="text-xs px-2 py-0.5 rounded-full ${kw.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}">
                        ${kw.is_active ? 'Active' : 'Paused'}
                    </span>
                </div>
                <div class="flex items-center gap-2">
                    <button onclick="toggleKeywordActive('${kw.id}', ${!kw.is_active})" class="text-xs ${kw.is_active ? 'text-amber-600 hover:text-amber-700' : 'text-green-600 hover:text-green-700'} transition-colors">
                        ${kw.is_active ? 'Pause' : 'Activate'}
                    </button>
                    <button onclick="editKeyword('${kw.id}')" class="text-xs text-brand-600 hover:text-brand-700 transition-colors">
                        Edit
                    </button>
                    <button onclick="deleteKeyword('${kw.id}')" class="text-xs text-red-500 hover:text-red-700 transition-colors">
                        Delete
                    </button>
                </div>
            </div>
            <div class="flex flex-wrap gap-1.5 mb-2">
                ${(kw.keywords || []).map(k => `<span class="text-xs bg-brand-50 text-brand-700 px-2 py-0.5 rounded-full">${escapeHtml(k)}</span>`).join('')}
            </div>
            <div class="flex flex-wrap gap-3 text-xs text-ink-400">
                ${kw.min_price || kw.max_price ? `<span>Price: ${kw.min_price ? '$' + kw.min_price : ''}${kw.min_price && kw.max_price ? '-' : ''}${kw.max_price ? '$' + kw.max_price : ''}</span>` : ''}
                ${kw.min_commission_rate ? `<span>Min Commission: ${kw.min_commission_rate}%</span>` : ''}
                ${kw.min_rating ? `<span>Min Rating: ${kw.min_rating}</span>` : ''}
                ${kw.sort_by ? `<span>Sort: ${kw.sort_by.replace('_', ' ')}</span>` : ''}
                ${kw.target_currency && kw.target_currency !== 'USD' ? `<span>Currency: ${kw.target_currency}</span>` : ''}
            </div>
        </div>
    `).join('');
}

function showKeywordModal(keyword = null) {
    const modal = document.getElementById('keywordModal');
    if (!modal) return;

    const isEdit = !!keyword;
    document.getElementById('keywordModalTitle').textContent = isEdit ? 'Edit Keyword Set' : 'Create Keyword Set';
    document.getElementById('keywordModalSubmitBtn').textContent = isEdit ? 'Update' : 'Create';
    document.getElementById('keywordModalSubmitBtn').setAttribute('data-keyword-id', keyword?.id || '');

    // Populate fields
    document.getElementById('kwName').value = keyword?.name || '';
    document.getElementById('kwKeywords').value = (keyword?.keywords || []).join(', ');
    document.getElementById('kwCategory').value = keyword?.category || '';
    document.getElementById('kwMinPrice').value = keyword?.min_price || '';
    document.getElementById('kwMaxPrice').value = keyword?.max_price || '';
    document.getElementById('kwMinCommission').value = keyword?.min_commission_rate || '';
    document.getElementById('kwMinRating').value = keyword?.min_rating || '';
    document.getElementById('kwMinOrders').value = keyword?.min_orders || '';
    document.getElementById('kwSortBy').value = keyword?.sort_by || 'commission_rate';
    document.getElementById('kwCurrency').value = keyword?.target_currency || 'USD';

    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function closeKeywordModal() {
    const modal = document.getElementById('keywordModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
}

async function submitKeyword() {
    const btn = document.getElementById('keywordModalSubmitBtn');
    const keywordId = btn?.getAttribute('data-keyword-id');

    const keywordsRaw = document.getElementById('kwKeywords')?.value?.trim();
    if (!keywordsRaw) {
        showToast('Please enter at least one keyword.', 'error');
        return;
    }

    const keywords = keywordsRaw.split(',').map(k => k.trim()).filter(Boolean);
    if (keywords.length === 0) {
        showToast('Please enter valid keywords.', 'error');
        return;
    }

    const payload = {
        name: document.getElementById('kwName')?.value?.trim() || 'Default',
        keywords,
        category: document.getElementById('kwCategory')?.value?.trim() || null,
        minPrice: parseFloat(document.getElementById('kwMinPrice')?.value) || null,
        maxPrice: parseFloat(document.getElementById('kwMaxPrice')?.value) || null,
        minCommissionRate: parseFloat(document.getElementById('kwMinCommission')?.value) || null,
        minRating: parseFloat(document.getElementById('kwMinRating')?.value) || null,
        minOrders: parseInt(document.getElementById('kwMinOrders')?.value) || null,
        sortBy: document.getElementById('kwSortBy')?.value || 'commission_rate',
        targetCurrency: document.getElementById('kwCurrency')?.value || 'USD'
    };

    const originalText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

    try {
        if (keywordId) {
            await affApiPut(`/api/affiliate/keywords/${keywordId}`, payload);
            showToast('Keyword set updated.', 'success');
        } else {
            await affApiPost('/api/affiliate/keywords', payload);
            showToast('Keyword set created.', 'success');
        }
        closeKeywordModal();
        await loadKeywords();
    } catch (error) {
        showToast(error.message || 'Failed to save keyword set.', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = originalText; }
    }
}

function editKeyword(id) {
    const kw = affiliateKeywords.find(k => k.id === id);
    if (kw) showKeywordModal(kw);
}

async function deleteKeyword(id) {
    if (!confirm('Delete this keyword set? This cannot be undone.')) return;

    try {
        await affApiDelete(`/api/affiliate/keywords/${id}`);
        showToast('Keyword set deleted.', 'success');
        await loadKeywords();
    } catch (error) {
        showToast('Failed to delete keyword set.', 'error');
    }
}

async function toggleKeywordActive(id, isActive) {
    try {
        await affApiPut(`/api/affiliate/keywords/${id}`, { isActive });
        await loadKeywords();
    } catch (error) {
        showToast('Failed to update keyword status.', 'error');
    }
}

// ============================================
// PRODUCT PREVIEW & SEARCH
// ============================================

// ============================================
// CATEGORY FILTER
// ============================================

let _categoriesLoaded = false;

async function loadCategories() {
    if (_categoriesLoaded) return;
    const select = document.getElementById('productCategoryFilter');
    if (!select) return;

    try {
        const data = await affApiGet('/api/affiliate/categories');
        const categories = data.categories || [];

        for (const cat of categories) {
            // Top-level category
            const opt = document.createElement('option');
            opt.value = cat.categoryId;
            opt.textContent = cat.categoryName;
            select.appendChild(opt);

            // Sub-categories (indented)
            if (cat.children?.length) {
                for (const child of cat.children) {
                    const subOpt = document.createElement('option');
                    subOpt.value = child.categoryId;
                    subOpt.textContent = `  └ ${child.categoryName}`;
                    select.appendChild(subOpt);
                }
            }
        }
        _categoriesLoaded = true;
    } catch (e) {
        console.warn('Failed to load categories:', e.message);
    }
}

// ============================================
// PRODUCT SEARCH
// ============================================

// Track current search state for pagination
let _searchState = { keywords: '', sortBy: '', categoryId: '', pageNo: 1, totalResults: 0, pageSize: 20 };

async function previewProducts(pageNo) {
    const container = document.getElementById('productPreviewContainer');
    if (!container) return;

    const keywordsInput = document.getElementById('previewKeywords');
    const keywords = keywordsInput?.value?.trim();

    if (!keywords) {
        showToast('Enter keywords to search for products.', 'error');
        return;
    }

    const sortSelect = document.getElementById('productSortBy');
    const sortBy = sortSelect?.value || '';
    const categorySelect = document.getElementById('productCategoryFilter');
    const categoryId = categorySelect?.value || '';
    const page = pageNo || 1;

    _searchState.keywords = keywords;
    _searchState.sortBy = sortBy;
    _searchState.categoryId = categoryId;
    _searchState.pageNo = page;

    container.innerHTML = `
        <div class="text-center py-8">
            <div class="loader mx-auto mb-3" style="width:32px;height:32px;"></div>
            <p class="text-ink-400 text-sm">Searching AliExpress products...</p>
        </div>
    `;

    try {
        let url = `/api/affiliate/products/search?keywords=${encodeURIComponent(keywords)}&pageNo=${page}&pageSize=${_searchState.pageSize}`;
        if (sortBy) url += `&sortBy=${encodeURIComponent(sortBy)}`;
        if (categoryId) url += `&categoryIds=${encodeURIComponent(categoryId)}`;

        const data = await affApiGet(url);
        const products = data.products || [];
        const totalResults = data.totalResults || 0;
        _searchState.totalResults = totalResults;

        // Update results count
        const countEl = document.getElementById('searchResultsCount');
        if (countEl) {
            const start = (page - 1) * _searchState.pageSize + 1;
            const end = start + products.length - 1;
            countEl.textContent = totalResults > 0 ? `${start}-${end} of ${totalResults.toLocaleString()} results` : '';
        }

        if (products.length === 0) {
            container.innerHTML = `
                <div class="text-center py-8 text-ink-400">
                    <p class="font-medium">No products found</p>
                    <p class="text-sm mt-1">Try different keywords or broaden your search.</p>
                </div>
            `;
            return;
        }

        const totalPages = Math.ceil(totalResults / _searchState.pageSize);

        container.innerHTML = `
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                ${products.map(p => renderProductCard(p)).join('')}
            </div>
            ${totalPages > 1 ? `
            <div class="flex items-center justify-center gap-4 mt-6 pt-4 border-t border-surface-200">
                <button onclick="previewProducts(${page - 1})" class="btn-secondary btn-sm ${page <= 1 ? 'opacity-30 pointer-events-none' : ''}" ${page <= 1 ? 'disabled' : ''}>
                    <svg class="w-4 h-4 inline mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>Previous
                </button>
                <span class="text-sm text-ink-500">Page ${page} of ${totalPages.toLocaleString()}</span>
                <button onclick="previewProducts(${page + 1})" class="btn-secondary btn-sm ${page >= totalPages ? 'opacity-30 pointer-events-none' : ''}" ${page >= totalPages ? 'disabled' : ''}>
                    Next<svg class="w-4 h-4 inline ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
                </button>
            </div>` : ''}
        `;
    } catch (error) {
        container.innerHTML = `
            <div class="text-center py-8 text-red-400">
                <p class="font-medium">Search failed</p>
                <p class="text-sm mt-1">${escapeHtml(error.message || 'Please try again.')}</p>
            </div>
        `;
    }
}

async function previewHotProducts() {
    const container = document.getElementById('productPreviewContainer');
    if (!container) return;

    container.innerHTML = `
        <div class="text-center py-8">
            <div class="loader mx-auto mb-3" style="width:32px;height:32px;"></div>
            <p class="text-ink-400 text-sm">Fetching hot products...</p>
        </div>
    `;

    try {
        const data = await affApiGet('/api/affiliate/products/hot');
        const products = data.products || [];

        if (products.length === 0) {
            container.innerHTML = `
                <div class="text-center py-8 text-ink-400">
                    <p class="font-medium">No hot products found</p>
                </div>
            `;
            return;
        }

        container.innerHTML = `
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                ${products.map(p => renderProductCard(p)).join('')}
            </div>
        `;
    } catch (error) {
        container.innerHTML = `
            <div class="text-center py-8 text-red-400">
                <p class="font-medium">Failed to load hot products</p>
                <p class="text-sm mt-1">${escapeHtml(error.message || 'Please try again.')}</p>
            </div>
        `;
    }
}

function renderProductCard(product) {
    const discount = product.discount ? Math.round(product.discount) : 0;
    const commission = product.commissionRate ? product.commissionRate.toFixed(1) : '0';
    const rating = product.rating ? product.rating.toFixed(1) : 'N/A';
    const orders = product.totalOrders ? product.totalOrders.toLocaleString() : '0';

    return `
        <div class="card-gradient rounded-xl p-4 flex gap-4">
            <div class="w-20 h-20 rounded-lg overflow-hidden flex-shrink-0 bg-surface-100">
                ${product.imageUrl ? `<img src="${escapeHtml(product.imageUrl)}" alt="" class="w-full h-full object-cover" loading="lazy" onerror="this.style.display='none'">` : ''}
            </div>
            <div class="flex-1 min-w-0">
                <h4 class="text-sm font-medium text-ink-800 line-clamp-2 mb-1">${escapeHtml(product.title || 'Untitled')}</h4>
                <div class="flex items-center gap-2 mb-1">
                    ${product.originalPrice && product.originalPrice > product.salePrice ? `<span class="text-xs text-ink-400 line-through">$${product.originalPrice.toFixed(2)}</span>` : ''}
                    <span class="text-sm font-bold text-green-600">$${(product.salePrice || 0).toFixed(2)}</span>
                    ${discount > 0 ? `<span class="text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full font-medium">${discount}% OFF</span>` : ''}
                </div>
                <div class="flex flex-wrap gap-2 text-xs text-ink-400">
                    <span class="bg-green-50 text-green-700 px-1.5 py-0.5 rounded">${commission}% comm.</span>
                    <span>${rating} rating</span>
                    <span>${orders} orders</span>
                </div>
                <div class="mt-2">
                    <button onclick="postProduct('${escapeHtml(product.productId)}', this)" class="text-xs text-brand-600 hover:text-brand-700 font-medium transition-colors">
                        Post Now
                    </button>
                </div>
            </div>
        </div>
    `;
}

async function postProduct(productId, btnEl) {
    // Show platform selector
    const platform = await showPlatformSelector();
    if (!platform) return;

    const originalHtml = btnEl ? btnEl.innerHTML : '';
    if (btnEl) { btnEl.disabled = true; btnEl.innerHTML = 'Posting...'; }

    try {
        const result = await affApiPost('/api/affiliate/products/post', { productId, platform });
        showToast(`Product posted to ${platform} successfully!`, 'success');
    } catch (error) {
        showToast(error.message || 'Failed to post product.', 'error');
    } finally {
        if (btnEl) { btnEl.disabled = false; btnEl.innerHTML = originalHtml; }
    }
}

function showPlatformSelector() {
    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.className = 'fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50';
        modal.innerHTML = `
            <div class="bg-surface-0 rounded-2xl shadow-2xl p-6 max-w-xs w-full mx-4">
                <h3 class="text-lg font-bold text-ink-800 mb-4" style="font-family: 'Satoshi', sans-serif;">Select Platform</h3>
                <div class="space-y-3">
                    <button onclick="this.closest('.fixed').resolve('whatsapp')" class="w-full flex items-center gap-3 p-3 rounded-xl border border-surface-200 hover:border-green-300 hover:bg-green-50 transition-all">
                        <div class="w-9 h-9 rounded-lg bg-green-100 flex items-center justify-center">
                            <svg class="w-5 h-5 text-green-600" fill="currentColor" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.625.846 5.059 2.284 7.034L.789 23.492a.5.5 0 00.612.638l4.67-1.318A11.94 11.94 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 22a9.94 9.94 0 01-5.332-1.543l-.38-.23-2.87.81.742-2.757-.253-.4A9.96 9.96 0 012 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10z"/></svg>
                        </div>
                        <span class="font-medium text-ink-800">WhatsApp</span>
                    </button>
                    <button onclick="this.closest('.fixed').resolve('telegram')" class="w-full flex items-center gap-3 p-3 rounded-xl border border-surface-200 hover:border-blue-300 hover:bg-blue-50 transition-all">
                        <div class="w-9 h-9 rounded-lg bg-blue-100 flex items-center justify-center">
                            <svg class="w-5 h-5 text-blue-600" fill="currentColor" viewBox="0 0 24 24"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
                        </div>
                        <span class="font-medium text-ink-800">Telegram</span>
                    </button>
                </div>
                <button onclick="this.closest('.fixed').resolve(null)" class="mt-4 w-full text-center text-sm text-ink-400 hover:text-ink-600 transition-colors">Cancel</button>
            </div>
        `;

        modal.resolve = (value) => {
            document.body.removeChild(modal);
            resolve(value);
        };

        document.body.appendChild(modal);
    });
}

// ============================================
// PUBLISHED PRODUCTS HISTORY
// ============================================

async function loadHistory() {
    const container = document.getElementById('historyContainer');
    if (!container) return;

    container.innerHTML = `
        <div class="text-center py-6">
            <div class="loader mx-auto" style="width:24px;height:24px;"></div>
        </div>
    `;

    try {
        const data = await affApiGet('/api/affiliate/history');
        affiliateHistory = data.products || [];
        renderHistory();
    } catch (error) {
        container.innerHTML = `<p class="text-center text-ink-400 py-4">Failed to load history.</p>`;
    }
}

function renderHistory() {
    const container = document.getElementById('historyContainer');
    if (!container) return;

    if (affiliateHistory.length === 0) {
        container.innerHTML = `
            <div class="text-center py-8 text-ink-400">
                <p class="font-medium">No products published yet</p>
                <p class="text-sm mt-1">Products posted through affiliate agents will appear here.</p>
            </div>
        `;
        return;
    }

    container.innerHTML = `
        <div class="overflow-x-auto">
            <table class="w-full text-sm">
                <thead>
                    <tr class="text-left text-xs text-ink-400 uppercase tracking-wider border-b border-surface-200">
                        <th class="pb-2 pr-4">Product</th>
                        <th class="pb-2 pr-4">Platform</th>
                        <th class="pb-2 pr-4">Commission</th>
                        <th class="pb-2 pr-4">Price</th>
                        <th class="pb-2">Date</th>
                    </tr>
                </thead>
                <tbody>
                    ${affiliateHistory.map(p => `
                        <tr class="border-b border-surface-100">
                            <td class="py-3 pr-4">
                                <span class="text-ink-800 line-clamp-1">${escapeHtml(p.product_title || p.productTitle || 'Unknown')}</span>
                            </td>
                            <td class="py-3 pr-4">
                                <span class="text-xs px-2 py-0.5 rounded-full ${p.platform === 'whatsapp' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}">
                                    ${p.platform === 'whatsapp' ? 'WhatsApp' : 'Telegram'}
                                </span>
                            </td>
                            <td class="py-3 pr-4 text-green-600">${p.commission_rate || p.commissionRate || 'N/A'}%</td>
                            <td class="py-3 pr-4">$${(p.sale_price || p.salePrice || 0).toFixed(2)}</td>
                            <td class="py-3 text-ink-400">${new Date(p.published_at || p.publishedAt).toLocaleDateString()}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;
}

// ============================================
// AFFILIATE SUB-TAB NAVIGATION
// ============================================

function showAffiliateSubTab(tabName) {
    // Hide all sub-tab contents
    document.querySelectorAll('.aff-subtab-content').forEach(el => el.classList.add('hidden'));

    // Remove active from all sub-tab buttons
    document.querySelectorAll('.aff-tab-btn').forEach(btn => btn.classList.remove('tab-active'));

    // Show selected
    const content = document.getElementById(`aff-content-${tabName}`);
    const tab = document.getElementById(`aff-tab-${tabName}`);
    if (content) content.classList.remove('hidden');
    if (tab) tab.classList.add('tab-active');

    // Lazy-load data for certain tabs
    if (tabName === 'products' && affiliateCredentials?.oauthConnected) {
        // Products tab ready for search
    } else if (tabName === 'history') {
        loadHistory();
    }
}

// ============================================
// API HELPERS (affiliate-specific)
// ============================================

async function affApiGet(url) {
    const token = localStorage.getItem('token');
    const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` },
        credentials: 'include'
    });
    const data = await response.json();
    if (!response.ok) {
        if (response.status === 403 && data.error?.includes('Affiliate add-on required')) {
            const banner = document.getElementById('affiliateAddonRequiredBanner');
            if (banner) banner.classList.remove('hidden');
        }
        throw new Error(data.error || 'Request failed');
    }
    return data;
}

async function affApiPost(url, body) {
    const token = localStorage.getItem('token');
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-CSRF-Token': getCsrfToken()
        },
        credentials: 'include',
        body: body ? JSON.stringify(body) : undefined
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Request failed');
    return data;
}

async function affApiPut(url, body) {
    const token = localStorage.getItem('token');
    const response = await fetch(url, {
        method: 'PUT',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-CSRF-Token': getCsrfToken()
        },
        credentials: 'include',
        body: body ? JSON.stringify(body) : undefined
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Request failed');
    return data;
}

async function affApiDelete(url) {
    const token = localStorage.getItem('token');
    const response = await fetch(url, {
        method: 'DELETE',
        headers: {
            'Authorization': `Bearer ${token}`,
            'X-CSRF-Token': getCsrfToken()
        },
        credentials: 'include'
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Request failed');
    return data;
}

// ============================================
// UTILITIES
// ============================================

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
}
