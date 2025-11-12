// ============================================
// SUPABASE CONFIGURATION
// ============================================
const USE_SUPABASE = false;

const SUPABASE_URL = 'https://jzegylvfipujssamzqux.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp6ZWd5bHZmaXB1anNzYW16cXV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI0NDYzNDIsImV4cCI6MjA3ODAyMjM0Mn0.l_9o4-0qP0YMmnJhbTvBJJliiOMf5UNBULpD_K-Uci4';

// Initialize Supabase client (disabled when USE_SUPABASE is false)
const supabase = USE_SUPABASE && window.supabase
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

// Authentication state
let currentUser = null;

// ============================================
// OFFLINE MODE & SYNC QUEUE
// ============================================

// Sync queue storage key
const SYNC_QUEUE_KEY = 'offlineSyncQueue';
const OFFLINE_MODE_KEY = 'offlineMode';

// Offline state
let isOnline = navigator.onLine;
let syncInProgress = false;

// Precious metal market data (Yahoo Finance futures contracts per troy ounce)
const YAHOO_FINANCE_BASE_URL = 'https://query1.finance.yahoo.com/v7/finance/quote';
const YAHOO_FINANCE_METAL_SYMBOLS = {
    Gold: 'GC=F',
    Silver: 'SI=F',
    Platinum: 'PL=F',
    Palladium: 'PA=F'
};
const DEFAULT_YAHOO_FINANCE_PROXY = 'https://cors.isomorphic-git.org';
let preciousMetalPrices = {};
let preciousMetalLastUpdated = null;
let preciousMetalFetchInFlight = false;

function getWindowConfig(key, fallback = null) {
    if (typeof window !== 'undefined' && Object.prototype.hasOwnProperty.call(window, key)) {
        return window[key];
    }
    return fallback;
}

function buildUrlWithProxy(originalUrl, proxyUrl) {
    if (!proxyUrl) return originalUrl;
    const trimmedProxy = proxyUrl.endsWith('/') ? proxyUrl.slice(0, -1) : proxyUrl;
    return `${trimmedProxy}/${originalUrl}`;
}

function getYahooFinanceProxy() {
    return getWindowConfig('DESERT_EXCHANGE_YAHOO_PROXY', DEFAULT_YAHOO_FINANCE_PROXY);
}

function shouldUseYahooProxyByDefault() {
    if (typeof window === 'undefined') {
        return false;
    }
    if (window.DESERT_EXCHANGE_FORCE_YAHOO_PROXY === true) {
        return true;
    }
    return window.location && window.location.protocol === 'file:';
}

function buildYahooFinanceUrl(symbols, { useProxy } = {}) {
    const validSymbols = Array.isArray(symbols) ? symbols.filter(Boolean) : [];
    const joinedSymbols = validSymbols.join(',');
    const baseUrl = `${YAHOO_FINANCE_BASE_URL}?symbols=${encodeURIComponent(joinedSymbols)}`;

    const proxyRequested = typeof useProxy === 'boolean' ? useProxy : shouldUseYahooProxyByDefault();
    if (proxyRequested) {
        const proxyUrl = getYahooFinanceProxy();
        if (proxyUrl) {
            const trimmedProxy = proxyUrl.endsWith('/') ? proxyUrl.slice(0, -1) : proxyUrl;
            return `${trimmedProxy}/${baseUrl}`;
        }
    }

    return baseUrl;
}

function shouldFallbackToProxy(error) {
    if (shouldUseYahooProxyByDefault()) {
        return true;
    }

    if (!error) {
        return false;
    }

    if (typeof error.status === 'number' && (error.status === 401 || error.status === 403)) {
        return true;
    }

    const message = (error && error.message) ? error.message : '';
    return error.name === 'TypeError'
        || /fetch/i.test(message)
        || /CORS/i.test(message)
        || /Access-Control-Allow-Origin/i.test(message);
}

if (typeof window !== 'undefined') {
    if (typeof window.renderAppointmentsCalendar !== 'function') {
        window.renderAppointmentsCalendar = function renderAppointmentsCalendarPlaceholder(appointments = []) {
            console.warn('renderAppointmentsCalendar placeholder executed – calendar UI not implemented yet.', appointments);
        };
    }
    if (typeof renderAppointmentsCalendar !== 'function') {
        var renderAppointmentsCalendar = window.renderAppointmentsCalendar;
    }
}

function parseMissingColumnFromError(error) {
    if (!error || !error.message) return null;
    const match = error.message.match(/column\s+"([^"]+)"/i);
    return match ? match[1] : null;
}

// Initialize offline mode system
function initOfflineMode() {
    // Listen for online/offline events
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    
    // Check initial status
    updateOfflineStatus();
    
    // Try to sync any pending changes on load
    if (isOnline) {
        syncPendingChanges();
    }
    
    // Periodically try to sync if offline (every 30 seconds)
    setInterval(() => {
        if (isOnline && !syncInProgress) {
            syncPendingChanges();
        }
    }, 30000);
}

// Handle coming online
async function handleOnline() {
    console.log('Connection restored - syncing pending changes');
    isOnline = true;
    updateOfflineStatus();
    await syncPendingChanges();
    await fetchPreciousMetalPrices({ force: true });
}

// Handle going offline
function handleOffline() {
    console.log('Connection lost - entering offline mode');
    isOnline = false;
    updateOfflineStatus();
    renderLiveMetalPrices(new Error('Offline mode – live prices paused.'));
}

function toggleRefreshButtonLoading(isLoading) {
    const refreshBtn = document.getElementById('refresh-prices-btn');
    if (!refreshBtn) return;

    if (isLoading) {
        if (!refreshBtn.dataset.originalLabel) {
            refreshBtn.dataset.originalLabel = refreshBtn.textContent.trim();
        }
        refreshBtn.disabled = true;
        refreshBtn.classList.add('loading');
        refreshBtn.textContent = 'Refreshing...';
        refreshBtn.setAttribute('aria-busy', 'true');
    } else {
        refreshBtn.disabled = false;
        refreshBtn.classList.remove('loading');
        refreshBtn.removeAttribute('aria-busy');
        if (refreshBtn.dataset.originalLabel) {
            refreshBtn.textContent = refreshBtn.dataset.originalLabel;
        }
    }
}

function renderLiveMetalPrices(error = null) {
    const livePricesDisplay = document.getElementById('live-prices-display');
    if (!livePricesDisplay) return;

    livePricesDisplay.style.display = 'block';

    if (error) {
        const message = error && error.message ? error.message : 'Unknown error';
        const isFileOrigin = typeof window !== 'undefined' && window.location && window.location.protocol === 'file:';
        const proxyHint = isFileOrigin
            ? `<div class="metal-prices-error-hint">Tip: When opening the app directly from a file, most APIs block requests. Launch the app through a local web server or define <code>window.DESERT_EXCHANGE_YAHOO_PROXY</code> to point at a CORS proxy.</div>`
            : '';
        livePricesDisplay.innerHTML = `
            <div class="metal-prices-error">
                <strong>Unable to load live prices.</strong>
                <div class="metal-prices-error-message">${message}</div>
                ${proxyHint}
            </div>
        `;
        return;
    }

    const entries = Object.entries(preciousMetalPrices);
    if (entries.length === 0) {
        livePricesDisplay.innerHTML = `
            <div class="metal-prices-empty">
                Live metal prices are unavailable right now. Try refreshing.
            </div>
        `;
        return;
    }

    const updated = preciousMetalLastUpdated ? new Date(preciousMetalLastUpdated) : null;
    const rowsHtml = entries.map(([metal, info]) => {
        const formattedPrice = typeof info.price === 'number'
            ? formatCurrency(info.price)
            : 'N/A';
        return `
            <div class="metal-price-row">
                <span class="metal-price-label">${metal}</span>
                <span class="metal-price-value">${formattedPrice}</span>
                <span class="metal-price-symbol">${info.symbol || ''}</span>
            </div>
        `;
    }).join('');

    livePricesDisplay.innerHTML = `
        <div class="metal-prices-wrapper">
            ${rowsHtml}
            ${updated ? `<div class="metal-prices-updated">Last updated ${updated.toLocaleString()}</div>` : ''}
        </div>
    `;
}

function updateCalculatorMarketPrice({ triggerRecalculate = false, force = false } = {}) {
    const metalSelect = document.getElementById('calc-metal');
    const marketPriceInput = document.getElementById('calc-market-price');

    if (!metalSelect || !marketPriceInput) return;

    const selectedMetal = metalSelect.value;
    if (!selectedMetal) return;

    const metalInfo = preciousMetalPrices[selectedMetal];
    if (!metalInfo || typeof metalInfo.price !== 'number' || !Number.isFinite(metalInfo.price)) {
        return;
    }

    const currentValue = parseFloat(marketPriceInput.value);
    const shouldOverwrite = force || !marketPriceInput.value || marketPriceInput.dataset.autoFilled === 'true' || !Number.isFinite(currentValue);

    if (!shouldOverwrite) return;

    marketPriceInput.value = metalInfo.price.toFixed(2);
    marketPriceInput.dataset.autoFilled = 'true';

    if (triggerRecalculate && typeof shouldAutoCalculate === 'function' && shouldAutoCalculate()) {
        calculateMetal();
    }
}

async function fetchPreciousMetalPrices({ force = false, useProxyOverride = undefined } = {}) {
    if (preciousMetalFetchInFlight) {
        return preciousMetalPrices;
    }

    if (!isOnline && !force) {
        console.warn('Skipping precious metal price fetch because the app is offline.');
        renderLiveMetalPrices(new Error('Offline mode – live prices paused.'));
        return preciousMetalPrices;
    }

    const now = Date.now();
    const cacheTTL = 5 * 60 * 1000; // 5 minutes
    if (!force && preciousMetalLastUpdated && (now - preciousMetalLastUpdated) < cacheTTL) {
        updateCalculatorMarketPrice({ triggerRecalculate: false, force: false });
        renderLiveMetalPrices();
        return preciousMetalPrices;
    }

    const symbolList = Object.values(YAHOO_FINANCE_METAL_SYMBOLS);
    const resolvedUseProxy = typeof useProxyOverride === 'boolean'
        ? useProxyOverride
        : shouldUseYahooProxyByDefault();
    const requestUrl = buildYahooFinanceUrl(symbolList, { useProxy: resolvedUseProxy });

    toggleRefreshButtonLoading(true);
    preciousMetalFetchInFlight = true;

    try {
        const response = await fetch(requestUrl, {
            cache: 'no-store',
            mode: 'cors',
            headers: {
                accept: 'application/json, text/plain, */*'
            }
        });
        if (!response.ok) {
            const error = new Error(`Yahoo Finance request failed with status ${response.status}`);
            error.status = response.status;
            error.useProxy = resolvedUseProxy;
            throw error;
        }

        const rawBody = await response.text();
        let payload;
        try {
            payload = JSON.parse(rawBody);
        } catch (parseError) {
            const error = new Error('Unable to parse Yahoo Finance response.');
            error.cause = parseError;
            throw error;
        }

        const results = payload && payload.quoteResponse && Array.isArray(payload.quoteResponse.result)
            ? payload.quoteResponse.result
            : [];

        if (!results.length) {
            throw new Error('Yahoo Finance returned no precious metal quotes.');
        }

        const mapped = {};
        for (const [metal, symbol] of Object.entries(YAHOO_FINANCE_METAL_SYMBOLS)) {
            const quote = results.find(item => item.symbol === symbol);
            if (!quote) continue;

            const price = typeof quote.regularMarketPrice === 'number'
                ? quote.regularMarketPrice
                : (typeof quote.ask === 'number' ? quote.ask : (typeof quote.bid === 'number' ? quote.bid : null));

            if (price === null || !Number.isFinite(price)) continue;

            mapped[metal] = {
                symbol,
                price,
                currency: quote.currency || 'USD',
                timestamp: quote.regularMarketTime ? quote.regularMarketTime * 1000 : Date.now()
            };
        }

        if (!Object.keys(mapped).length) {
            throw new Error('Unable to map Yahoo Finance quotes to precious metals.');
        }

        preciousMetalPrices = mapped;
        preciousMetalLastUpdated = Date.now();

        renderLiveMetalPrices();
        updateCalculatorMarketPrice({ triggerRecalculate: true, force: true });
    } catch (error) {
        console.error('Failed to fetch precious metal prices from Yahoo Finance:', error);
        if (resolvedUseProxy !== true && shouldFallbackToProxy(error)) {
            console.warn('Retrying precious metal price fetch through Yahoo Finance proxy.');
            return fetchPreciousMetalPrices({ force, useProxyOverride: true });
        }
        renderLiveMetalPrices(error);
    } finally {
        preciousMetalFetchInFlight = false;
        toggleRefreshButtonLoading(false);
    }

    return preciousMetalPrices;
}

// Update offline status UI
function updateOfflineStatus() {
    const statusDiv = document.getElementById('offline-status');
    const indicator = document.getElementById('offline-indicator');
    const pendingCount = document.getElementById('sync-pending-count');
    const queue = getSyncQueue();
    
    if (!statusDiv || !indicator) return;
    
    if (!isOnline || queue.length > 0) {
        statusDiv.style.display = 'flex';
        statusDiv.style.alignItems = 'center';
        statusDiv.style.gap = '8px';
        
        if (!isOnline) {
            indicator.className = 'offline-indicator offline';
            indicator.title = 'Offline Mode - Changes will sync when connection is restored';
        } else {
            indicator.className = 'offline-indicator syncing';
            indicator.title = 'Online - Syncing pending changes...';
        }
        
        if (queue.length > 0) {
            if (pendingCount) {
                pendingCount.textContent = queue.length;
                pendingCount.style.display = 'inline-block';
            }
        } else {
            if (pendingCount) pendingCount.style.display = 'none';
            if (isOnline) {
                indicator.className = 'offline-indicator online';
                indicator.title = 'Online - All changes synced';
            }
        }
    } else {
        statusDiv.style.display = 'none';
    }
}

// Get sync queue from localStorage
function getSyncQueue() {
    try {
        const queue = localStorage.getItem(SYNC_QUEUE_KEY);
        return queue ? JSON.parse(queue) : [];
    } catch (error) {
        console.error('Error reading sync queue:', error);
        return [];
    }
}

// Add item to sync queue
function addToSyncQueue(operation) {
    const queue = getSyncQueue();
    operation.id = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    operation.timestamp = Date.now();
    queue.push(operation);
    localStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(queue));
    updateOfflineStatus();
    console.log('Added to sync queue:', operation.type, queue.length, 'items pending');
}

// Remove item from sync queue
function removeFromSyncQueue(operationId) {
    const queue = getSyncQueue();
    const filtered = queue.filter(op => op.id !== operationId);
    localStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(filtered));
    updateOfflineStatus();
}

// Clear sync queue
function clearSyncQueue() {
    localStorage.removeItem(SYNC_QUEUE_KEY);
    updateOfflineStatus();
}

// Sync pending changes
async function syncPendingChanges() {
    if (!USE_SUPABASE) return;
    if (!isOnline || syncInProgress) return;
    
    const queue = getSyncQueue();
    if (queue.length === 0) {
        updateOfflineStatus();
        return;
    }
    
    syncInProgress = true;
    console.log(`Syncing ${queue.length} pending operations...`);
    
    const failed = [];
    
    for (const operation of queue) {
        try {
            let success = false;
            
            switch (operation.type) {
                case 'saveEvent':
                    await syncSaveEvent(operation.data);
                    success = true;
                    break;
                case 'deleteEvent':
                    await syncDeleteEvent(operation.data);
                    success = true;
                    break;
                case 'saveBuyListItems':
                    await syncSaveBuyListItems(operation.data);
                    success = true;
                    break;
                case 'saveSales':
                    await syncSaveSales(operation.data);
                    success = true;
                    break;
                case 'saveExpenses':
                    await syncSaveExpenses(operation.data);
                    success = true;
                    break;
                case 'saveBuySheet':
                    await syncSaveBuySheet(operation.data);
                    success = true;
                    break;
                case 'savePlannedEvent':
                    await syncSavePlannedEvent(operation.data);
                    success = true;
                    break;
                case 'deletePlannedEvent':
                    await syncDeletePlannedEvent(operation.data);
                    success = true;
                    break;
                case 'saveCustomer':
                    await saveCustomerToDB(operation.data);
                    success = true;
                    break;
                case 'deleteCustomer':
                    await deleteCustomerFromDB(operation.data.name);
                    success = true;
                    break;
                case 'clearCustomers':
                    await syncClearCustomers(operation.data);
                    success = true;
                    break;
                default:
                    console.warn('Unknown operation type:', operation.type);
            }
            
            if (success) {
                removeFromSyncQueue(operation.id);
                console.log('Synced operation:', operation.type);
            }
        } catch (error) {
            console.error('Error syncing operation:', operation.type, error);
            // Keep failed operations in queue for retry
            failed.push(operation);
        }
    }
    
    syncInProgress = false;
    updateOfflineStatus();
    
    if (failed.length === 0 && queue.length > 0) {
        console.log('All pending changes synced successfully');
    } else if (failed.length > 0) {
        console.warn(`${failed.length} operations failed to sync and will be retried`);
    }
}

// Sync helper functions (direct DB calls)
async function syncSaveEvent(data) {
    const eventId = await saveEventToDB(data.event);
    if (eventId) {
        const oldId = data.event.id;
        data.event.id = eventId;
        
        // If this was a temp ID, update all references
        if (data.event.tempId) {
            // Update in cache
            const cacheIndex = eventsCache.findIndex(e => (e.tempId && e.tempId === data.event.tempId) || e.id === oldId);
            if (cacheIndex !== -1) {
                eventsCache[cacheIndex] = { ...data.event };
            }
            
            // Update in localStorage
            const events = JSON.parse(localStorage.getItem('events') || '[]');
            const index = events.findIndex(e => (e.tempId && e.tempId === data.event.tempId) || (oldId && e.id === oldId));
            if (index !== -1) {
                events[index] = { ...data.event };
                // Update currentEvent if it matches
                if (currentEvent === data.event.tempId || currentEvent === oldId) {
                    currentEvent = eventId;
                    const selector = document.getElementById('event-selector');
                    if (selector) selector.value = eventId;
                }
            }
            localStorage.setItem('events', JSON.stringify(events));
        }
        
        // Save related data
        if ((data.buyList || data.sales || data.expenses)) {
            await Promise.all([
                data.buyList ? saveBuyListItemsToDB(eventId, data.buyList) : Promise.resolve(),
                data.sales ? saveSalesToDB(eventId, data.sales) : Promise.resolve(),
                data.expenses ? saveExpensesToDB(eventId, data.expenses) : Promise.resolve(),
                data.buyList ? saveBuySheetsForEvent(eventId, data.buyList) : Promise.resolve()
            ]);
        }
    }
}

async function syncDeleteEvent(data) {
    await deleteEventFromDB(data.eventId);
}

async function syncSaveBuyListItems(data) {
    await saveBuyListItemsToDB(data.eventId, data.items);
}

async function syncSaveSales(data) {
    await saveSalesToDB(data.eventId, data.sales);
}

async function syncSaveExpenses(data) {
    await saveExpensesToDB(data.eventId, data.expenses);
}

async function syncClearCustomers() {
    try {
        const userId = getUserId();
        if (!userId) {
            console.warn('Cannot clear customers: missing user ID');
            return;
        }

        await supabase
            .from('customers')
            .delete()
            .eq('user_id', userId);

        await supabase
            .from('deleted_customers')
            .delete()
            .eq('user_id', userId);
    } catch (error) {
        console.error('Error clearing customers in Supabase:', error);
        throw error;
    }
}

async function syncSaveBuySheet(data) {
    await saveBuySheetToDB(data.eventId, data.buySheet);
}

async function syncSavePlannedEvent(data) {
    await savePlannedEventToDB(data.event);
}

async function syncDeletePlannedEvent(data) {
    await deletePlannedEventFromDB(data.eventId);
}

// Wrapper function to execute DB operation (online) or queue it (offline)
async function executeOrQueue(operation) {
    if (!USE_SUPABASE) {
        return;
    }
    
    if (isOnline) {
        try {
            // Try to execute immediately
            await syncPendingChanges(); // Sync any pending first
            
            // Execute the operation based on type
            switch (operation.type) {
                case 'saveEvent':
                    await syncSaveEvent(operation.data);
                    break;
                case 'deleteEvent':
                    await syncDeleteEvent(operation.data);
                    break;
                case 'saveBuyListItems':
                    await syncSaveBuyListItems(operation.data);
                    break;
                case 'saveSales':
                    await syncSaveSales(operation.data);
                    break;
                case 'saveExpenses':
                    await syncSaveExpenses(operation.data);
                    break;
                case 'saveBuySheet':
                    await syncSaveBuySheet(operation.data);
                    break;
                case 'savePlannedEvent':
                    await syncSavePlannedEvent(operation.data);
                    break;
                case 'deletePlannedEvent':
                    await syncDeletePlannedEvent(operation.data);
                    break;
                case 'saveCustomer':
                    await saveCustomerToDB(operation.data);
                    break;
                case 'deleteCustomer':
                    await deleteCustomerFromDB(operation.data.name);
                    break;
                case 'clearCustomers':
                    await syncClearCustomers(operation.data);
                    break;
            }
        } catch (error) {
            console.error('Error executing operation, queuing for retry:', error);
            // If it fails, queue it for retry
            addToSyncQueue(operation);
            throw error;
        }
    } else {
        // Offline - queue the operation
        addToSyncQueue(operation);
        console.log('Offline - operation queued:', operation.type);
    }
}
// ============================================
// AUTHENTICATION FUNCTIONS
// ============================================
// Initialize authentication
// Clear all UI elements to prevent flash of old content
function clearAllUI(clearEventSelector = false) {
    // Only clear event selector if explicitly requested (e.g., on logout)
    if (clearEventSelector) {
        const eventSelector = document.getElementById('event-selector');
        if (eventSelector) eventSelector.innerHTML = '<option value="">Loading...</option>';
    }
    
    // Clear dashboard content
    const dashboardContent = document.getElementById('dashboard-content');
    if (dashboardContent) dashboardContent.innerHTML = '';
    
    // Clear welcome message
    const welcomeMessage = document.getElementById('welcome-message');
    const welcomeSubtitle = document.getElementById('welcome-subtitle');
    const welcomeAvatarImg = document.getElementById('welcome-avatar-img');
    const welcomeAvatarPlaceholder = document.getElementById('welcome-avatar-placeholder');
    if (welcomeMessage) welcomeMessage.textContent = 'Welcome Back!';
    if (welcomeSubtitle) welcomeSubtitle.textContent = 'Loading...';
    if (welcomeAvatarImg) {
        welcomeAvatarImg.src = '';
        welcomeAvatarImg.style.display = 'none';
    }
    if (welcomeAvatarPlaceholder) {
        welcomeAvatarPlaceholder.textContent = '';
        welcomeAvatarPlaceholder.style.display = 'flex';
    }
    
    // Clear buy list
    const buyListTbody = document.getElementById('buy-list-tbody');
    if (buyListTbody) buyListTbody.innerHTML = '<tr><td colspan="12" class="empty-message">Loading...</td></tr>';
    
    // Clear sales list
    const salesTbody = document.getElementById('sales-tbody');
    if (salesTbody) salesTbody.innerHTML = '<tr><td colspan="9" class="empty-message">Loading...</td></tr>';
    
    // Clear expenses list
    const expensesTbody = document.getElementById('expenses-tbody');
    if (expensesTbody) expensesTbody.innerHTML = '<tr><td colspan="4" class="empty-message">Loading...</td></tr>';
    
    // DO NOT clear reports HTML structure - just reset values
    // The P/L HTML must remain intact for display to work
    const plTotalOfferEl = document.getElementById('pl-total-offer');
    const plTotalRevenueEl = document.getElementById('pl-total-revenue');
    const plSummaryExpensesEl = document.getElementById('pl-summary-expenses');
    const plNetProfitEl = document.getElementById('pl-net-profit');
    if (plTotalOfferEl) plTotalOfferEl.textContent = '$0.00';
    if (plTotalRevenueEl) plTotalRevenueEl.textContent = '$0.00';
    if (plSummaryExpensesEl) plSummaryExpensesEl.textContent = '$0.00';
    if (plNetProfitEl) plNetProfitEl.textContent = '$0.00';
    
    // Clear profile sections in settings
    const profileNameInput = document.getElementById('profile-name');
    const profileEmailInput = document.getElementById('profile-email');
    const profilePicturePreview = document.getElementById('profile-picture-preview');
    const profilePicturePlaceholder = document.getElementById('profile-picture-placeholder');
    if (profileNameInput) profileNameInput.value = '';
    if (profileEmailInput) profileEmailInput.value = '';
    if (profilePicturePreview) {
        profilePicturePreview.src = '';
        profilePicturePreview.style.display = 'none';
    }
    if (profilePicturePlaceholder) {
        profilePicturePlaceholder.innerHTML = '<span class="avatar-icon">👤</span>';
        profilePicturePlaceholder.style.display = 'flex';
    }
}

// Clear user-specific data when signing out or switching accounts
function clearUserData({ clearStorage = false, clearUI = false, clearEventSelector = false } = {}) {
    eventsCache = [];
    plannedEventsCache = [];
    customersCache = {};
    deletedCustomersCache = [];
    currentEvent = null;
    currentBuySheet = createEmptyBuySheet();
    
    if (clearStorage) {
    localStorage.removeItem('events');
    localStorage.removeItem('plannedEvents');
    localStorage.removeItem('currentEvent');
    localStorage.removeItem('currentBuySheet');
    }

    if (typeof crmState !== 'undefined' && crmState) {
        crmState.customers = [];
        crmState.map = new Map();
        crmState.selectedCustomer = null;
        crmState.pendingSelection = null;
        crmState.needsRefresh = true;
    }

    if (clearUI) {
        clearAllUI(clearEventSelector);
    }
}

async function initAuth() {
    // Show loading screen immediately
    const authLoading = document.getElementById('auth-loading');
    const authModal = document.getElementById('auth-modal');
    const mainApp = document.getElementById('main-app');
    
    if (!USE_SUPABASE || !supabase) {
        if (authLoading) authLoading.style.display = 'none';
        if (authModal) authModal.style.display = 'none';
        if (mainApp) mainApp.style.display = 'block';
        currentUser = {
            id: 'local-user',
            email: 'local@example.com',
            user_metadata: { full_name: 'Local User' }
        };
        window.authInitialized = true;
        await showApp();
        return;
    }
    
    if (authLoading) authLoading.style.display = 'flex';
    if (authModal) authModal.style.display = 'none';
    if (mainApp) mainApp.style.display = 'none';
    
    try {
    // Check for existing session
    const { data: { session } } = await supabase.auth.getSession();
    
        if (session && session.user) {
        currentUser = session.user;
            // Ensure employee profile exists
            await ensureEmployeeProfile(session.user);
            // Reset in-memory caches before showing app (preserve stored data)
            clearUserData({ clearUI: true, clearEventSelector: false });
            await showApp();
            // Mark as initialized to prevent re-initialization on token refresh
            window.authInitialized = true;
    } else {
            showAuth();
        }
    } catch (error) {
        console.error('Error initializing auth:', error);
        showAuth();
    }
    
    // Listen for auth changes
    // Track if we've already initialized to prevent re-initialization on token refresh
    // Use window object to persist across different scopes
    if (!window.authInitialized) {
        window.authInitialized = false;
    }
    
    supabase.auth.onAuthStateChange(async (event, session) => {
        console.log('Auth state changed:', event, session ? 'has session' : 'no session');
        
        // Reset logout button state on any auth state change
        const logoutBtn = document.getElementById('logout-btn');
        if (logoutBtn) {
            logoutBtn.disabled = false;
            logoutBtn.textContent = 'Logout';
        }
        
        // Handle token refresh - don't reset UI, just update user
        if (event === 'TOKEN_REFRESHED' && session && session.user) {
            console.log('Token refreshed, updating user but NOT resetting UI');
            currentUser = session.user;
            // Don't clear anything, just update user reference
            // The UI should remain unchanged
            return; // Don't do anything else on token refresh
        }
        
        // Only handle SIGNED_IN if we haven't initialized yet OR if it's a new sign in
        if (event === 'SIGNED_IN' && session && session.user) {
            // Check if this is the initial load or a new sign in
            if (!window.authInitialized || !currentUser || currentUser.id !== session.user.id) {
                console.log('New sign in detected, initializing app');
                currentUser = session.user;
                // Clear old data FIRST to prevent flash
                clearUserData({ clearUI: true, clearEventSelector: false });
                // Ensure employee profile exists for new users
                await ensureEmployeeProfile(session.user);
                // Small delay to ensure UI is cleared
                await new Promise(resolve => setTimeout(resolve, 100));
                await showApp();
                window.authInitialized = true;
            } else {
                console.log('Same user signed in, skipping re-initialization to preserve UI state');
                // Same user, just update current user but don't reset UI
                currentUser = session.user;
                // Only update welcome message, don't clear everything
                updateWelcomeMessage();
            }
        } else if (event === 'SIGNED_OUT') {
            console.log('User signed out');
            currentUser = null;
            window.authInitialized = false;
            clearUserData({ clearStorage: true, clearUI: true, clearEventSelector: true });
            showAuth();
        }
    });
}

// Show authentication modal
function showAuth() {
    if (!USE_SUPABASE || !supabase) {
        const mainApp = document.getElementById('main-app');
        if (mainApp) mainApp.style.display = 'block';
        return;
    }
    const authModal = document.getElementById('auth-modal');
    const mainApp = document.getElementById('main-app');
    const authLoading = document.getElementById('auth-loading');
    
    // Hide loading screen
    if (authLoading) authLoading.style.display = 'none';
    
    // Hide app content immediately
    if (mainApp) {
        mainApp.style.display = 'none';
        // Clear any cached content to prevent flash
        clearUserData({ clearUI: false, clearStorage: false });
    }
    
    // Show auth modal
    if (authModal) {
        authModal.style.display = 'flex';
        // Reset forms
        const loginForm = document.getElementById('login-form');
        const signupForm = document.getElementById('signup-form');
        const authError = document.getElementById('auth-error');
        if (loginForm) loginForm.reset();
        if (signupForm) signupForm.reset();
        if (authError) {
            authError.style.display = 'none';
            authError.textContent = '';
        }
    }
}

// Show main app
async function showApp() {
    const authModal = document.getElementById('auth-modal');
    const mainApp = document.getElementById('main-app');
    const authLoading = document.getElementById('auth-loading');
    
    // Hide loading screen
    if (authLoading) authLoading.style.display = 'none';
    
    // Hide auth modal immediately
    if (authModal) authModal.style.display = 'none';
    
    // IMPORTANT: Clear ALL UI content FIRST to prevent flash of old account data
    clearAllUI(false); // Don't clear event selector when showing app
    
    // Show app (will load content after)
    if (mainApp) mainApp.style.display = 'block';
    
    // Wait a moment to ensure UI is cleared and rendered before loading new data
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Initialize app UI after showing
    setTimeout(async () => {
        try {
            // Top navbar layout - ensure navbar is visible
            const navbar = document.querySelector('.navbar');
            if (navbar) {
                navbar.style.display = 'block';
                navbar.style.visibility = 'visible';
                navbar.style.opacity = '1';
                navbar.style.position = 'fixed';
                navbar.style.top = '0';
                navbar.style.left = '0';
                navbar.style.right = '0';
                navbar.style.width = '100%';
                navbar.style.zIndex = '1000';
            }
            
            // Initialize data from Supabase first (with error handling)
            try {
                await initializeDataFromDB();
            } catch (error) {
                console.error('Error initializing data from DB:', error);
                // Continue anyway - will use localStorage fallback
            }
            
            // Initialize app
            await initializeApp();
            
            // Initialize offline mode system
            initOfflineMode();
            
            // Update welcome message on initial load (after a small delay to ensure data is loaded)
            setTimeout(async () => {
                await updateWelcomeMessage();
            }, 200);
            
            // Adjust main content margin for fixed navbar
            adjustMainContentMargin();
        } catch (error) {
            console.error('Error in showApp initialization:', error);
            // Still try to show navbar and adjust layout
            const navbar = document.querySelector('.navbar');
            if (navbar) {
                navbar.style.display = 'block';
                navbar.style.visibility = 'visible';
                navbar.style.opacity = '1';
                navbar.style.position = 'fixed';
                navbar.style.top = '0';
                navbar.style.left = '0';
                navbar.style.right = '0';
                navbar.style.width = '100%';
                navbar.style.zIndex = '1000';
            }
            adjustMainContentMargin();
        }
    }, 100);
}
// Show login form
window.showLogin = function() {
    const loginForm = document.getElementById('login-form');
    const signupForm = document.getElementById('signup-form');
    const authTitle = document.getElementById('auth-title');
    const authError = document.getElementById('auth-error');
    if (loginForm) loginForm.style.display = 'block';
    if (signupForm) signupForm.style.display = 'none';
    if (authTitle) authTitle.textContent = 'Login';
    if (authError) authError.style.display = 'none';
};

// Show signup form
window.showSignup = function() {
    const loginForm = document.getElementById('login-form');
    const signupForm = document.getElementById('signup-form');
    const authTitle = document.getElementById('auth-title');
    const authError = document.getElementById('auth-error');
    if (loginForm) loginForm.style.display = 'none';
    if (signupForm) signupForm.style.display = 'block';
    if (authTitle) authTitle.textContent = 'Sign Up';
    if (authError) authError.style.display = 'none';
};
// Handle login
async function handleLogin(e) {
    e.preventDefault();
    const emailEl = document.getElementById('login-email');
    const passwordEl = document.getElementById('login-password');
    const errorEl = document.getElementById('auth-error');
    
    if (!emailEl || !passwordEl || !errorEl) return;
    
    const email = emailEl.value;
    const password = passwordEl.value;
    
    if (!USE_SUPABASE || !supabase) {
        currentUser = {
            id: 'local-user',
            email: email || 'local@example.com',
            user_metadata: { full_name: 'Local User' }
        };
        errorEl.style.display = 'none';
        await showApp();
        return;
    }
    
    const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password
    });
    
    if (error) {
        errorEl.textContent = error.message;
        errorEl.style.display = 'block';
    } else {
        currentUser = data.user;
        showApp();
    }
}
// Handle signup
async function handleSignup(e) {
    e.preventDefault();
    const emailEl = document.getElementById('signup-email');
    const passwordEl = document.getElementById('signup-password');
    const nameEl = document.getElementById('signup-name');
    const errorEl = document.getElementById('auth-error');
    
    if (!emailEl || !passwordEl || !nameEl || !errorEl) return;
    
    const email = emailEl.value;
    const password = passwordEl.value;
    const name = nameEl.value;
    
    if (!USE_SUPABASE || !supabase) {
        errorEl.textContent = 'Local mode: account created. You can log in immediately.';
        errorEl.style.display = 'block';
        errorEl.style.color = 'green';
        setTimeout(() => {
            showLogin();
        }, 1500);
        return;
    }
    
    const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
            data: {
                full_name: name
            }
        }
    });
    
    if (error) {
        errorEl.textContent = error.message;
        errorEl.style.display = 'block';
    } else {
        // Create user profile/employee entry if user was created
        if (data.user) {
            try {
                const { error: profileError } = await supabase
                    .from('user_profiles')
                    .upsert({
                        user_id: data.user.id,
                        email: email,
                        full_name: name,
                        role: 'user', // Default role for new employees
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString()
                    }, {
                        onConflict: 'user_id'
                    });
                
                if (profileError) {
                    console.warn('Could not create employee profile:', profileError);
                    // Profile might be created later via auth trigger or when they first log in
                } else {
                    console.log('Employee profile created successfully for:', email);
                }
            } catch (profileError) {
                console.warn('Error creating employee profile (table may not exist yet):', profileError);
                // Profile will be created when they first access settings or log in
            }
        }
        
        errorEl.textContent = 'Sign up successful! Please check your email to verify your account.';
        errorEl.style.display = 'block';
        errorEl.style.color = 'green';
        setTimeout(() => {
            showLogin();
        }, 2000);
    }
}
// Handle logout
window.handleLogout = async function() {
    console.log('Logout button clicked');
    
    const logoutBtn = document.getElementById('logout-btn');
    
    try {
        // Show loading state
        if (logoutBtn) {
            logoutBtn.disabled = true;
            logoutBtn.textContent = 'Logging out...';
        }
        
        // Clear data and UI immediately
        clearUserData({ clearStorage: true, clearUI: true, clearEventSelector: true });
        
        if (!USE_SUPABASE || !supabase) {
            currentUser = {
                id: 'local-user',
                email: 'local@example.com',
                user_metadata: { full_name: 'Local User' }
            };
            if (logoutBtn) {
                logoutBtn.disabled = false;
                logoutBtn.textContent = 'Logout';
            }
            await showApp();
            return;
        }
        
        // Sign out from Supabase
        const { error } = await supabase.auth.signOut();
        
        // Clear current user
    currentUser = null;
        
        // Always reset button state (even if error occurred)
        if (logoutBtn) {
            logoutBtn.disabled = false;
            logoutBtn.textContent = 'Logout';
        }
        
        if (error) {
            console.error('Error signing out:', error);
            alert('Error signing out: ' + (error.message || 'Unknown error'));
            return;
        }
        
        // Show auth screen
    showAuth();
        
        console.log('Logout successful');
    } catch (error) {
        console.error('Error in logout:', error);
        alert('Error during logout: ' + (error.message || 'Unknown error'));
        
        // Ensure button is always reset
        if (logoutBtn) {
            logoutBtn.disabled = false;
            logoutBtn.textContent = 'Logout';
        }
        
        // Still try to show auth screen
        currentUser = null;
        showAuth();
    }
};

// ============================================
// DATABASE SYNC FUNCTIONS
// ============================================

// Helper to get current user ID
function getUserId() {
    if (!currentUser) {
        throw new Error('User not authenticated');
    }
    return currentUser.id;
}

// ============================================
// EVENTS SYNC
// ============================================

// Load events from Supabase
async function loadEventsFromDB() {
    if (!USE_SUPABASE || !supabase) {
        return [];
    }
    try {
        const userId = getUserId();
        const { data, error } = await supabase
            .from('events')
            .select('*')
            .eq('user_id', userId)
            .order('date', { ascending: false });
        
        if (error) throw error;
        
        // Convert to format expected by app
        return (data || []).map(event => ({
            id: event.id,
            name: event.name,
            created: event.date,
            date: event.date,
            status: event.status || 'active',
            buyList: [],
            sales: [],
            expenses: []
        }));
    } catch (error) {
        console.error('Error loading events:', error);
        return [];
    }
}

// Save event to Supabase
async function saveEventToDB(event) {
    if (!USE_SUPABASE || !supabase) {
        return event.id || null;
    }
    try {
        const userId = getUserId();
        const eventData = {
            user_id: userId,
            name: event.name,
            date: event.date || event.created,
            status: event.status || 'active'
        };
        
        // Check if event has a valid UUID (Supabase IDs are UUIDs with dashes)
        const isUUID = event.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(event.id);
        
        if (isUUID) {
            // Update existing event (UUID from Supabase)
            const { error } = await supabase
                .from('events')
                .update(eventData)
                .eq('id', event.id)
                .eq('user_id', userId);
            
            if (error) throw error;
            return event.id; // Return existing ID
        } else {
            // Create new event
            const { data, error } = await supabase
                .from('events')
                .insert(eventData)
                .select()
                .single();
            
            if (error) throw error;
            return data.id; // Return new UUID
        }
    } catch (error) {
        console.error('Error saving event:', error);
        throw error;
    }
}

// Delete event from Supabase
async function deleteEventFromDB(eventId) {
    if (!USE_SUPABASE || !supabase) {
        return;
    }
    try {
        const userId = getUserId();
        const { error } = await supabase
            .from('events')
            .delete()
            .eq('id', eventId)
            .eq('user_id', userId);
        
        if (error) throw error;
    } catch (error) {
        console.error('Error deleting event:', error);
        throw error;
    }
}

// ============================================
// BUY SHEETS SYNC
// ============================================

// Save buy sheet to Supabase
async function saveBuySheetToDB(eventId, buySheet) {
    if (!USE_SUPABASE || !supabase) {
        return null;
    }
    try {
        const userId = getUserId();
        const customerInfo = buySheet.customer ? (getCustomerInfo(buySheet.customer) || {}) : {};
        const buySheetData = {
            user_id: userId,
            event_id: eventId,
            buy_sheet_id: buySheet.buySheetId || Date.now().toString(),
            customer: buySheet.customer || null,
            customer_name: buySheet.customer || null,
            customer_phone: buySheet.customerPhone || buySheet.phone || customerInfo.phone || null,
            customer_email: buySheet.customerEmail || buySheet.email || customerInfo.email || null,
            customer_address: buySheet.customerAddress || buySheet.address || customerInfo.address || null,
            customer_city: buySheet.customerCity || buySheet.city || customerInfo.city || null,
            customer_state: buySheet.customerState || buySheet.state || customerInfo.state || null,
            customer_zip: buySheet.customerZip || buySheet.zip || customerInfo.zip || null,
            notes: buySheet.notes || null,
            status: buySheet.status || 'pending',
            check_number: buySheet.checkNumber || null
        };
        
        // Upsert buy sheet
        const { data, error } = await supabase
            .from('buy_sheets')
            .upsert(buySheetData, {
                onConflict: 'user_id,event_id,buy_sheet_id',
                ignoreDuplicates: false
            })
            .select()
            .single();
        
        if (error) throw error;
        return data.id;
    } catch (error) {
        if (error.code === '42P01') {
            if (!window.buySheetsTableWarningShown) {
                alert('Heads up: the Supabase "buy_sheets" table is missing. Run the latest database migrations (database_schema.sql) so customer buy sheets persist across refreshes.');
                window.buySheetsTableWarningShown = true;
            }
            console.warn('buy_sheets table not found. Skipping individual buy sheet save. Run the latest database migrations to enable customer CRM syncing across sessions.');
            window.buySheetsTableMissing = true;
            return null;
        }
        console.error('Error saving buy sheet:', error);
        throw error;
    }
}

// Load buy sheet from Supabase
async function loadBuySheetFromDB(eventId, buySheetId) {
    if (!USE_SUPABASE || !supabase) {
        return null;
    }
    try {
        const userId = getUserId();
        const { data, error } = await supabase
            .from('buy_sheets')
            .select('*')
            .eq('user_id', userId)
            .eq('event_id', eventId)
            .eq('buy_sheet_id', buySheetId)
            .single();
        
        if (error && error.code !== 'PGRST116') throw error; // PGRST116 = not found
        
        if (!data) return null;
        
        return {
            customer: data.customer || data.customer_name || '',
            notes: data.notes || '',
            items: [],
            status: data.status || 'pending',
            checkNumber: data.check_number || null,
            buySheetId: data.buy_sheet_id
        };
    } catch (error) {
        console.error('Error loading buy sheet:', error);
        return null;
    }
}
async function loadBuySheetsForEventFromDB(eventId) {
    if (!USE_SUPABASE || !supabase) {
        return {};
    }
    try {
        const userId = getUserId();
        const { data, error } = await supabase
            .from('buy_sheets')
            .select('*')
            .eq('user_id', userId)
            .eq('event_id', eventId);
        
        if (error) throw error;
        
        const map = {};
        (data || []).forEach(sheet => {
            map[sheet.buy_sheet_id] = sheet;
            map[sheet.buy_sheet_id].customer = sheet.customer || sheet.customer_name || '';
            map[sheet.buy_sheet_id].customer_name = sheet.customer_name || sheet.customer || '';
        });
        return map;
    } catch (error) {
        if (error.code === '42P01') {
            if (!window.buySheetsTableWarningShown) {
                alert('Heads up: the Supabase "buy_sheets" table is missing. Run the latest database migrations (database_schema.sql) so customer buy sheets persist across refreshes.');
                window.buySheetsTableWarningShown = true;
            }
            console.warn('buy_sheets table not found. Skipping buy sheet metadata load. Run the latest database migrations to enable customer CRM syncing across sessions.');
            window.buySheetsTableMissing = true;
            return {};
        }
        console.error('Error loading buy sheets for event:', error);
        return {};
    }
}
// Save all buy sheets for an event (derived from buy list items)
async function saveBuySheetsForEvent(eventId, buyList) {
    if (!USE_SUPABASE || !supabase) {
        return;
    }
    try {
        const userId = getUserId();
        
        // Remove existing buy sheets for this event to avoid stale data
        await supabase
            .from('buy_sheets')
            .delete()
            .eq('user_id', userId)
            .eq('event_id', eventId);
        
        if (!buyList || buyList.length === 0) {
            return;
        }
        
        const buySheetMap = new Map();
        
        buyList.forEach(item => {
            const rawId = item.buySheetId || (item.buySheetIds && item.buySheetIds[0]);
            const sheetId = rawId ? String(rawId) : null;
            if (!sheetId) return;
            
            if (!buySheetMap.has(sheetId)) {
                buySheetMap.set(sheetId, {
                    buy_sheet_id: sheetId,
                    customer: item.customer || null,
                    notes: item.notes || null,
                    status: item.checkNumber ? 'confirmed' : 'pending',
                    check_number: item.checkNumber || null
                });
            } else {
                const sheet = buySheetMap.get(sheetId);
                if (!sheet.customer && item.customer) sheet.customer = item.customer;
                if (!sheet.notes && item.notes) sheet.notes = item.notes;
                if (!sheet.check_number && item.checkNumber) sheet.check_number = item.checkNumber;
                if (item.checkNumber) sheet.status = 'confirmed';
            }
        });
        
        if (buySheetMap.size === 0) {
            return;
        }

        const buildBuySheetsPayload = (includeMeta = true) => Array.from(buySheetMap.values()).map(sheet => {
            const customerInfo = sheet.customer ? (getCustomerInfo(sheet.customer) || {}) : {};
            const payload = {
            user_id: userId,
            event_id: eventId,
            buy_sheet_id: sheet.buy_sheet_id,
            customer: sheet.customer,
            notes: sheet.notes,
            status: sheet.status,
            check_number: sheet.check_number
            };

            if (includeMeta) {
                payload.customer_name = sheet.customer || null;
                payload.customer_phone = sheet.customerPhone || sheet.phone || customerInfo.phone || null;
                payload.customer_email = sheet.customerEmail || sheet.email || customerInfo.email || null;
                payload.customer_address = sheet.customerAddress || sheet.address || customerInfo.address || null;
                payload.customer_city = sheet.customerCity || sheet.city || customerInfo.city || null;
                payload.customer_state = sheet.customerState || sheet.state || customerInfo.state || null;
                payload.customer_zip = sheet.customerZip || sheet.zip || customerInfo.zip || null;
            } else {
                payload.customer_name = sheet.customer || null;
            }

            return payload;
        });

        let buySheetsData = buildBuySheetsPayload(true);
        let { error } = await supabase
            .from('buy_sheets')
            .upsert(buySheetsData, {
                onConflict: 'user_id,event_id,buy_sheet_id',
                ignoreDuplicates: false
            });
        
        if (error && error.code === '42703') {
            console.warn('buy_sheets metadata columns missing. Falling back to minimal payload. Please run the latest database migrations to add these columns.');
            window.buySheetsMetaColumnsMissing = true;
            buySheetsData = buildBuySheetsPayload(false);
            const retry = await supabase
                .from('buy_sheets')
                .upsert(buySheetsData, {
                    onConflict: 'user_id,event_id,buy_sheet_id',
                    ignoreDuplicates: false
                });
            error = retry.error;
        }
        
        if (error) throw error;
    } catch (error) {
        if (error.code === '42P01') {
            if (!window.buySheetsTableWarningShown) {
                alert('Heads up: the Supabase "buy_sheets" table is missing. Run the latest database migrations (database_schema.sql) so customer buy sheets persist across refreshes.');
                window.buySheetsTableWarningShown = true;
            }
            console.warn('buy_sheets table not found. Skipping buy sheet metadata save. Run the latest database migrations to enable customer CRM syncing across sessions.');
            window.buySheetsTableMissing = true;
            return;
        }
        console.error('Error saving buy sheets for event:', error);
        throw error;
    }
}

// ============================================
// BUY LIST ITEMS SYNC
// ============================================

// Save buy list items to Supabase
async function saveBuyListItemsToDB(eventId, items) {
    if (!USE_SUPABASE || !supabase) {
        return;
    }
    try {
        const userId = getUserId();
        
        // Delete existing items for this event
        await supabase
            .from('buy_list_items')
            .delete()
            .eq('user_id', userId)
            .eq('event_id', eventId);
        
        if (items.length === 0) return;
        
        const buildItemsPayload = (includeMeta = true) => items.map(item => {
            const payload = {
                user_id: userId,
                event_id: eventId,
                buy_sheet_id_string: item.buySheetId ? String(item.buySheetId) : (item.buySheetIds?.length ? String(item.buySheetIds[0]) : null),
                category: item.category || '',
                description: item.description || item.item_name || null,
                item_name: item.item_name || item.description || null,
                metal: item.metal || null,
                karat: item.karat || null,
                purity: item.purity || null,
                weight: item.weight || 0,
                quantity: item.quantity || 1,
                market_price_per_gram: item.marketPricePerGram || null,
                market_price_per_ounce: item.marketPricePerOunce || null,
                full_melt: item.fullMelt || null,
                offer: item.offer || 0,
                profit: item.profit || 0,
                date_purchased: item.datePurchased || new Date().toISOString().split('T')[0],
                is_non_metal: item.isNonMetal || false,
                sold_weight: item.soldWeight || 0,
                merge_history: item.mergeHistory || null
            };
            
                payload.customer = item.customer || null;
            if (includeMeta) {
                payload.notes = item.notes || null;
            }
            payload.check_number = item.checkNumber || null;
            
            return payload;
        });
        
        let itemsData = buildItemsPayload(true);
        let { error } = await supabase
            .from('buy_list_items')
            .insert(itemsData);
        
        if (error && error.code === '42703') {
            console.warn('buy_list_items metadata columns missing (notes and/or check_number). Falling back to minimal payload. Please run the latest database migrations to add these columns.');
            window.buyListItemMetaColumnsMissing = true;
            itemsData = buildItemsPayload(false);
            const retry = await supabase
                .from('buy_list_items')
                .insert(itemsData);
            error = retry.error;
        }
        
        if (error) throw error;
    } catch (error) {
        console.error('Error saving buy list items:', error);
        throw error;
    }
}

// Load buy list items from Supabase
async function loadBuyListItemsFromDB(eventId) {
    if (!USE_SUPABASE || !supabase) {
        return [];
    }
    try {
        const userId = getUserId();
        const [itemsResponse, buySheetsMap] = await Promise.all([
            supabase
                .from('buy_list_items')
                .select('*')
                .eq('user_id', userId)
                .eq('event_id', eventId)
                .order('date_purchased', { ascending: false }),
            loadBuySheetsForEventFromDB(eventId)
        ]);
        
        const { data, error } = itemsResponse;
        if (error) throw error;
        
        // Convert to format expected by app
        return (data || []).map(item => ({
            id: item.id,
            category: item.category,
            description: item.description || item.item_name,
            item_name: item.item_name || item.description,
            metal: item.metal,
            karat: item.karat,
            purity: item.purity,
            weight: item.weight,
            quantity: item.quantity || 1,
            marketPricePerGram: item.market_price_per_gram,
            marketPricePerOunce: item.market_price_per_ounce,
            fullMelt: item.full_melt,
            offer: item.offer,
            profit: item.profit || 0,
            datePurchased: item.date_purchased,
            isNonMetal: item.is_non_metal || false,
            soldWeight: item.sold_weight || 0,
            buySheetId: item.buy_sheet_id_string || null,
            buySheetIds: item.buy_sheet_id_string ? [item.buy_sheet_id_string] : [],
            mergeHistory: item.merge_history,
            customer: buySheetsMap[item.buy_sheet_id_string]?.customer || buySheetsMap[item.buy_sheet_id_string]?.customer_name || item.customer || item.customer_name || '',
            notes: buySheetsMap[item.buy_sheet_id_string]?.notes || item.notes || null,
            checkNumber: buySheetsMap[item.buy_sheet_id_string]?.check_number || item.check_number || null,
            status: buySheetsMap[item.buy_sheet_id_string]?.status || (buySheetsMap[item.buy_sheet_id_string]?.check_number ? 'confirmed' : (item.check_number ? 'confirmed' : 'pending'))
        }));
    } catch (error) {
        console.error('Error loading buy list items:', error);
        return [];
    }
}

// ============================================
// SALES SYNC
// ============================================

// Save sales to Supabase
async function saveSalesToDB(eventId, sales) {
    if (!USE_SUPABASE || !supabase) {
        return;
    }
    try {
        const userId = getUserId();
        
        // Delete existing sales for this event
        await supabase
            .from('sales')
            .delete()
            .eq('user_id', userId)
            .eq('event_id', eventId);
        
        if (sales.length === 0) return;
        
        // Insert new sales
        const salesData = sales.map(sale => ({
            user_id: userId,
            event_id: eventId,
            buy_item_id_string: sale.buyItemId || null,
            category: sale.category || null,
            metal_type: sale.metalType || sale.metal || null,
            karat: sale.karat || null,
            weight_sold: sale.weightSold || null,
            sale_price: sale.salePrice || sale.totalRevenue || 0,
            sale_price_per_gram: sale.salePricePerGram || null,
            buyer: sale.buyer || null,
            sale_date: sale.saleDate || sale.date || new Date().toISOString().split('T')[0],
            profit: sale.profit || null,
            purchase_cost: sale.purchaseCost || null
        }));
        
        const { error } = await supabase
            .from('sales')
            .insert(salesData);
        
        if (error) throw error;
    } catch (error) {
        console.error('Error saving sales:', error);
        throw error;
    }
}
// Load sales from Supabase
async function loadSalesFromDB(eventId) {
    if (!USE_SUPABASE || !supabase) {
        return [];
    }
    try {
        const userId = getUserId();
        const { data, error } = await supabase
            .from('sales')
            .select('*')
            .eq('user_id', userId)
            .eq('event_id', eventId)
            .order('sale_date', { ascending: false });
        
        if (error) throw error;
        
        // Convert to format expected by app
        return (data || []).map(sale => ({
            id: sale.id,
            buyItemId: sale.buy_item_id_string,
            category: sale.category,
            metalType: sale.metal_type,
            metal: sale.metal_type,
            karat: sale.karat,
            weightSold: sale.weight_sold,
            salePrice: sale.sale_price,
            totalRevenue: sale.sale_price,
            salePricePerGram: sale.sale_price_per_gram,
            buyer: sale.buyer,
            saleDate: sale.sale_date,
            date: sale.sale_date,
            profit: sale.profit,
            purchaseCost: sale.purchase_cost
        }));
    } catch (error) {
        console.error('Error loading sales:', error);
        return [];
    }
}
// ============================================
// EXPENSES SYNC
// ============================================

// Save expenses to Supabase
async function saveExpensesToDB(eventId, expenses) {
    if (!USE_SUPABASE || !supabase) {
        return;
    }
    try {
        const userId = getUserId();
        
        // Delete existing expenses for this event
        await supabase
            .from('expenses')
            .delete()
            .eq('user_id', userId)
            .eq('event_id', eventId);
        
        if (expenses.length === 0) return;
        
        // Insert new expenses
        const expensesData = expenses.map(expense => ({
            user_id: userId,
            event_id: eventId,
            category: expense.category || '',
            description: expense.description || '',
            amount: expense.amount || 0,
            expense_date: expense.expenseDate || expense.date || new Date().toISOString().split('T')[0]
        }));
        
        const { error } = await supabase
            .from('expenses')
            .insert(expensesData);
        
        if (error) throw error;
    } catch (error) {
        console.error('Error saving expenses:', error);
        throw error;
    }
}
// Load expenses from Supabase
async function loadExpensesFromDB(eventId) {
    if (!USE_SUPABASE || !supabase) {
        return [];
    }
    try {
        const userId = getUserId();
        const { data, error } = await supabase
            .from('expenses')
            .select('*')
            .eq('user_id', userId)
            .eq('event_id', eventId)
            .order('expense_date', { ascending: false });
        
        if (error) throw error;
        
        // Convert to format expected by app
        return (data || []).map(expense => ({
            id: expense.id,
            category: expense.category,
            description: expense.description,
            amount: expense.amount,
            expenseDate: expense.expense_date,
            date: expense.expense_date
        }));
    } catch (error) {
        console.error('Error loading expenses:', error);
        return [];
    }
}

// ============================================
// CUSTOMERS SYNC
// ============================================

// Load customers from Supabase
async function loadCustomersFromDB() {
    if (!USE_SUPABASE || !supabase) {
        return {};
    }
    try {
        const userId = getUserId();
        const { data, error } = await supabase
            .from('customers')
            .select('*')
            .eq('user_id', userId)
            .order('name', { ascending: true });
        
        if (error) throw error;
        
        // Convert to format expected by app (object with name as key)
        const customersObj = {};
        (data || []).forEach(customer => {
            customersObj[customer.name] = {
                name: customer.name,
                phone: customer.phone || '',
                email: customer.email || '',
                address: customer.address || '',
                city: customer.city || '',
                state: customer.state || '',
                zip: customer.zip || '',
                notes: customer.notes || ''
            };
        });
        
        // Merge with local storage (local takes precedence for most recent updates)
        const localCustomers = getCustomersData();
        const mergedCustomers = { ...customersObj, ...localCustomers };
        
        // Save merged data back to local storage
        saveCustomersData(mergedCustomers);
        
        console.log('Loaded customers from Supabase:', Object.keys(customersObj).length);
        return mergedCustomers;
    } catch (error) {
        console.error('Error loading customers:', error);
        // Return local storage data as fallback
        return getCustomersData();
    }
}

// Save customer to Supabase
async function saveCustomerToDB(customerData) {
    if (!USE_SUPABASE || !supabase) {
        return;
    }
    try {
        const userId = getUserId();
        const customer = {
            user_id: userId,
            name: customerData.name,
            phone: customerData.phone || null,
            email: customerData.email || null,
            address: customerData.address || null,
            city: customerData.city || null,
            state: customerData.state || null,
            zip: customerData.zip || null,
            notes: customerData.notes || null,
            updated_at: new Date().toISOString()
        };
        
        console.log('Saving customer to Supabase:', customer);
        
        const { data, error } = await supabase
            .from('customers')
            .upsert(customer, {
                onConflict: 'user_id,name'
            })
            .select();
        
        if (error) {
            console.error('Supabase error saving customer:', error);
            throw error;
        }
        
        console.log('Customer saved successfully to Supabase:', data);
        return data;
    } catch (error) {
        console.error('Error saving customer to database:', error);
        throw error;
    }
}

// Delete customer from Supabase
async function deleteCustomerFromDB(customerName) {
    if (!USE_SUPABASE || !supabase) {
        return;
    }
    try {
        const userId = getUserId();

        // Remove any explicit CRM record first (avoid unique constraint conflicts later)
        const { error: deleteError } = await supabase
            .from('customers')
            .delete()
            .eq('user_id', userId)
            .eq('name', customerName);
        
        if (deleteError) throw deleteError;

        // Optionally, also log the deletion in deleted_customers table for tracking
        await supabase
            .from('deleted_customers')
            .upsert({ user_id: userId, customer_name: customerName }, {
                onConflict: 'user_id,customer_name',
                ignoreDuplicates: false
            });
    } catch (error) {
        console.error('Error deleting customer:', error);
        throw error;
    }
}

// ============================================
// DELETED CUSTOMERS SYNC
// ============================================

// Load deleted customers from Supabase
async function loadDeletedCustomersFromDB() {
    if (!USE_SUPABASE || !supabase) {
        return [];
    }
    try {
        const userId = getUserId();
        const { data, error } = await supabase
            .from('deleted_customers')
            .select('customer_name')
            .eq('user_id', userId);
        
        if (error) throw error;
        
        return (data || []).map(d => d.customer_name);
    } catch (error) {
        console.error('Error loading deleted customers:', error);
        return [];
    }
}

// Add deleted customer to Supabase
async function addDeletedCustomerToDB(customerName) {
    try {
        const userId = getUserId();
        const { error } = await supabase
            .from('deleted_customers')
            .upsert({
                user_id: userId,
                customer_name: customerName
            }, {
                onConflict: 'user_id,customer_name',
                ignoreDuplicates: false
            });
        
        if (error) throw error;
    } catch (error) {
        console.error('Error adding deleted customer:', error);
        throw error;
    }
}
// ============================================
// REFINERIES SYNC
// ============================================
// Load refineries from Supabase
async function loadRefineriesFromDB() {
    if (!USE_SUPABASE || !supabase) {
        return [];
    }
    try {
        const userId = getUserId();
        const { data, error } = await supabase
            .from('refineries')
            .select('name')
            .eq('user_id', userId)
            .order('name', { ascending: true });
        
        if (error) throw error;
        
        const names = (data || []).map(r => r.name);
        
        // If no refineries, return defaults
        if (names.length === 0) {
            return ['Elemental', 'Elemental Refinery'];
        }
        
        return names;
    } catch (error) {
        console.error('Error loading refineries:', error);
        return ['Elemental', 'Elemental Refinery'];
    }
}
// Save refineries to Supabase
async function saveRefineriesToDB(names) {
    if (!USE_SUPABASE || !supabase) {
        return;
    }
    try {
        const userId = getUserId();
        
        // Delete existing refineries
        await supabase
            .from('refineries')
            .delete()
            .eq('user_id', userId);
        
        if (names.length === 0) return;
        
        // Insert new refineries
        const refineriesData = names.map(name => ({
            user_id: userId,
            name: name
        }));
        
        const { error } = await supabase
            .from('refineries')
            .insert(refineriesData);
        
        if (error) throw error;
    } catch (error) {
        console.error('Error saving refineries:', error);
        throw error;
    }
}

// ============================================
// PLANNED EVENTS SYNC
// ============================================

// Load planned events from Supabase
async function loadPlannedEventsFromDB() {
    if (!USE_SUPABASE || !supabase) {
        return [];
    }
    try {
        const userId = getUserId();
        const { data, error } = await supabase
            .from('planned_events')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });
        
        if (error) throw error;
        
        // Convert to format expected by app
        return (data || []).map(event => ({
            id: event.id,
            name: event.name,
            city: event.city,
            stateCode: event.state_code,
            venue: event.venue,
            venuePhone: event.venue_phone,
            venueAddress: event.venue_address,
            startDate: event.start_date,
            endDate: event.end_date,
            status: event.status || 'draft',
            notes: event.notes,
            estimatedSpend: event.estimated_spend,
            estimatedRoi: event.estimated_roi,
            researchData: event.research_data
        }));
    } catch (error) {
        console.error('Error loading planned events:', error);
        return [];
    }
}
// Save planned event to Supabase
async function savePlannedEventToDB(event) {
    if (!USE_SUPABASE || !supabase) {
        return null;
    }
    try {
        const userId = getUserId();
        const eventData = {
            user_id: userId,
            name: event.name,
            city: event.city || null,
            state_code: event.stateCode || null,
            venue: event.venue || null,
            venue_phone: event.venuePhone || null,
            venue_address: event.venueAddress || null,
            start_date: event.startDate || null,
            end_date: event.endDate || null,
            status: event.status || 'draft',
            notes: event.notes || null,
            estimated_spend: event.estimatedSpend || null,
            estimated_roi: event.estimatedRoi || null,
            research_data: event.researchData || null
        };
        
        if (event.id && event.id.includes('-')) {
            // Update existing event (UUID)
            const { error } = await supabase
                .from('planned_events')
                .update(eventData)
                .eq('id', event.id)
                .eq('user_id', userId);
            
            if (error) throw error;
        } else {
            // Create new event
            const { data, error } = await supabase
                .from('planned_events')
                .insert(eventData)
                .select()
                .single();
            
            if (error) throw error;
            return data.id;
        }
    } catch (error) {
        console.error('Error saving planned event:', error);
        throw error;
    }
}

// Delete planned event from Supabase
async function deletePlannedEventFromDB(eventId) {
    if (!USE_SUPABASE || !supabase) {
        return;
    }
    try {
        const userId = getUserId();
        const { error } = await supabase
            .from('planned_events')
            .delete()
            .eq('id', eventId)
            .eq('user_id', userId);
        
        if (error) throw error;
    } catch (error) {
        console.error('Error deleting planned event:', error);
        throw error;
    }
}
// ============================================
// LOCAL APPOINTMENTS SYNC
// ============================================
// Load local appointments from Supabase
async function loadLocalAppointmentsFromDB() {
    if (!USE_SUPABASE || !supabase) {
        return [];
    }
    try {
        const userId = getUserId();
        const { data, error } = await supabase
            .from('local_appointments')
            .select('*')
            .eq('user_id', userId)
            .order('start_date_time', { ascending: true });
        
        if (error) throw error;
        
        // Convert to format expected by app
        return (data || []).map(apt => ({
            id: apt.id,
            customer: apt.customer || '',
            address: apt.address,
            date: apt.date,
            startTime: apt.start_time,
            duration: apt.duration || 30,
            notes: apt.notes || '',
            startDateTime: apt.start_date_time,
            endDateTime: apt.end_date_time,
            created: apt.created_at
        }));
    } catch (error) {
        console.error('Error loading local appointments:', error);
        return [];
    }
}

// Save local appointment to Supabase
async function saveLocalAppointmentToDB(appointment) {
    if (!USE_SUPABASE || !supabase) {
        return null;
    }
    try {
        const userId = getUserId();
        const appointmentData = {
            user_id: userId,
            customer: appointment.customer || null,
            address: appointment.address,
            date: appointment.date,
            start_time: appointment.startTime,
            duration: appointment.duration || 30,
            notes: appointment.notes || null,
            start_date_time: appointment.startDateTime,
            end_date_time: appointment.endDateTime
        };
        
        const { data, error } = await supabase
            .from('local_appointments')
            .insert(appointmentData)
            .select()
            .single();
        
        if (error) throw error;
        return data.id;
    } catch (error) {
        console.error('Error saving local appointment:', error);
        throw error;
    }
}

// ============================================
// COMPLETED APPOINTMENTS SYNC
// ============================================

// Load completed appointments from Supabase
async function loadCompletedAppointmentsFromDB() {
    if (!USE_SUPABASE || !supabase) {
        return [];
    }
    try {
        const userId = getUserId();
        const { data, error } = await supabase
            .from('completed_appointments')
            .select('appointment_uri')
            .eq('user_id', userId);
        
        if (error) throw error;
        
        return (data || []).map(d => d.appointment_uri);
    } catch (error) {
        console.error('Error loading completed appointments:', error);
        return [];
    }
}

// Toggle completed appointment in Supabase
async function toggleCompletedAppointmentInDB(appointmentUri) {
    try {
        const userId = getUserId();
        
        // Check if already completed
        const { data: existing } = await supabase
            .from('completed_appointments')
            .select('id')
            .eq('user_id', userId)
            .eq('appointment_uri', appointmentUri)
            .single();
        
        if (existing) {
            // Remove from completed
            const { error } = await supabase
                .from('completed_appointments')
                .delete()
                .eq('user_id', userId)
                .eq('appointment_uri', appointmentUri);
            
            if (error) throw error;
        } else {
            // Add to completed
            const { error } = await supabase
                .from('completed_appointments')
                .insert({
                    user_id: userId,
                    appointment_uri: appointmentUri
                });
            
            if (error) throw error;
        }
    } catch (error) {
        console.error('Error toggling completed appointment:', error);
        throw error;
    }
}

// ============================================
// ROUTE PLANNER STOPS SYNC
// ============================================

// Load route planner stops from Supabase
async function loadRouteStopsFromDB() {
    if (!USE_SUPABASE || !supabase) {
        return [];
    }
    try {
        const userId = getUserId();
        const { data, error } = await supabase
            .from('route_planner_stops')
            .select('*')
            .eq('user_id', userId)
            .order('stop_order', { ascending: true });
        
        if (error) throw error;
        
        // Convert to format expected by app
        return (data || []).map(stop => ({
            id: stop.stop_id,
            address: stop.address,
            originalAddress: stop.original_address,
            notes: stop.notes || '',
            lat: stop.lat,
            lng: stop.lng,
            order: stop.stop_order,
            appointmentUri: stop.appointment_uri || null
        }));
    } catch (error) {
        console.error('Error loading route stops:', error);
        return [];
    }
}

// Save route planner stops to Supabase
async function saveRouteStopsToDB(stops) {
    if (!USE_SUPABASE || !supabase) {
        return;
    }
    try {
        const userId = getUserId();
        
        // Delete existing stops
        await supabase
            .from('route_planner_stops')
            .delete()
            .eq('user_id', userId);
        
        if (stops.length === 0) return;
        
        // Insert new stops
        const stopsData = stops.map(stop => ({
            user_id: userId,
            stop_id: stop.id,
            address: stop.address,
            original_address: stop.originalAddress || stop.address,
            notes: stop.notes || null,
            lat: stop.lat,
            lng: stop.lng,
            stop_order: stop.order || 0,
            appointment_uri: stop.appointmentUri || null
        }));
        
        const { error } = await supabase
            .from('route_planner_stops')
            .insert(stopsData);
        
        if (error) throw error;
    } catch (error) {
        console.error('Error saving route stops:', error);
        throw error;
    }
}

// ============================================
// MASTER INITIALIZATION FUNCTION
// ============================================

// Global data cache (loaded from Supabase)
let eventsCache = [];
let customersCache = {};
let deletedCustomersCache = [];
let refineriesCache = [];
let plannedEventsCache = [];
let localAppointmentsCache = [];
let completedAppointmentsCache = [];
let routeStopsCache = [];
// Initialize all data from Supabase
async function initializeDataFromDB() {
    if (!USE_SUPABASE || !supabase) {
        return false;
    }
    try {
        if (!currentUser) {
            console.warn('No user authenticated, skipping Supabase initialization');
            return false;
        }
        
        console.log('Initializing data from Supabase...');
        console.log('Current user:', currentUser ? currentUser.id : 'No user');
        
        // Load all data in parallel
        const [
            events,
            customers,
            deletedCustomers,
            refineries,
            plannedEvents,
            localAppointments,
            completedAppointments,
            routeStops
        ] = await Promise.all([
            loadEventsFromDB().catch(err => { console.error('Error loading events:', err); return []; }),
            loadCustomersFromDB().catch(err => { console.error('Error loading customers:', err); return {}; }),
            loadDeletedCustomersFromDB().catch(err => { console.error('Error loading deleted customers:', err); return []; }),
            loadRefineriesFromDB().catch(err => { console.error('Error loading refineries:', err); return []; }),
            loadPlannedEventsFromDB().catch(err => { console.error('Error loading planned events:', err); return []; }),
            loadLocalAppointmentsFromDB().catch(err => { console.error('Error loading local appointments:', err); return []; }),
            loadCompletedAppointmentsFromDB().catch(err => { console.error('Error loading completed appointments:', err); return []; }),
            loadRouteStopsFromDB().catch(err => { console.error('Error loading route stops:', err); return []; })
        ]);
        
        console.log('Loaded from Supabase:', {
            events: events.length,
            customers: Object.keys(customers).length,
            plannedEvents: plannedEvents.length
        });
        
        // Cache the data
        eventsCache = events;
        customersCache = customers;
        deletedCustomersCache = deletedCustomers;
        refineriesCache = refineries;
        plannedEventsCache = plannedEvents;
        localAppointmentsCache = localAppointments;
        completedAppointmentsCache = completedAppointments;
        routeStopsCache = routeStops;
        
        // Load buy list items, sales, and expenses for each event
        for (const event of eventsCache) {
            try {
                const [buyList, sales, expenses] = await Promise.all([
                    loadBuyListItemsFromDB(event.id).catch(err => { console.error(`Error loading buy list for event ${event.id}:`, err); return []; }),
                    loadSalesFromDB(event.id).catch(err => { console.error(`Error loading sales for event ${event.id}:`, err); return []; }),
                    loadExpensesFromDB(event.id).catch(err => { console.error(`Error loading expenses for event ${event.id}:`, err); return []; })
                ]);
                
                event.buyList = buyList;
                event.sales = sales;
                event.expenses = expenses;
            } catch (error) {
                console.error(`Error loading event data for ${event.id}:`, error);
                event.buyList = event.buyList || [];
                event.sales = event.sales || [];
                event.expenses = event.expenses || [];
            }
        }
        
        console.log('Data initialized from Supabase:', {
            events: eventsCache.length,
            customers: Object.keys(customersCache).length,
            plannedEvents: plannedEventsCache.length,
            localAppointments: localAppointmentsCache.length
        });
        crmState.needsRefresh = true;
        
        return true;
    } catch (error) {
        console.error('Error initializing data from Supabase:', error);
        console.error('Error details:', error.message, error.stack);
        // Fallback to localStorage if DB fails
        console.warn('Falling back to localStorage...');
        return false;
    }
}
// App State
const BUY_SHEET_CONTACT_FIELDS = {
    phone: 'buy-sheet-phone',
    email: 'buy-sheet-email',
    address: 'buy-sheet-address',
    city: 'buy-sheet-city',
    state: 'buy-sheet-state',
    zip: 'buy-sheet-zip'
};

let currentEvent = null;
let currentBuySheet = createEmptyBuySheet();

// Dropdown functions - define early so they're available for inline onclick handlers
window.toggleDropdown = function(dropdownId, event) {
    console.log('toggleDropdown called:', dropdownId, event);
    
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    
    // Find dropdown by finding the button that was clicked, then its parent
    let dropdown = null;
    if (event && event.target) {
        const button = event.target.closest('.dropdown-toggle');
        if (button) {
            dropdown = button.closest('.nav-dropdown');
            console.log('Found dropdown via event.target:', dropdown);
        }
    }
    
    // Fallback: find by dropdown ID
    if (!dropdown) {
        const button = document.querySelector(`.dropdown-toggle[data-dropdown="${dropdownId}"]`);
        if (button) {
            dropdown = button.closest('.nav-dropdown');
            console.log('Found dropdown via button selector:', dropdown);
        }
    }
    
    if (!dropdown) {
        console.error('Dropdown not found:', dropdownId);
        console.log('Available dropdowns:', document.querySelectorAll('.nav-dropdown').length);
        return false;
    }
    
    // Close all other dropdowns
    document.querySelectorAll('.nav-dropdown').forEach(dd => {
        if (dd !== dropdown) {
            dd.classList.remove('active');
        }
    });
    
    // Toggle current dropdown
    const wasActive = dropdown.classList.contains('active');
    dropdown.classList.toggle('active');
    const isNowActive = dropdown.classList.contains('active');
    console.log('Dropdown toggled. Was:', wasActive, 'Now:', isNowActive);
    
    // Force menu visibility check
    const menu = dropdown.querySelector('.dropdown-menu');
    if (menu) {
        console.log('Menu found, checking styles...');
        const styles = window.getComputedStyle(menu);
        console.log('Visibility:', styles.visibility, 'Opacity:', styles.opacity, 'Display:', styles.display);
        
        // If active but not visible, force it
        if (isNowActive) {
            menu.style.visibility = 'visible';
            menu.style.opacity = '1';
            menu.style.display = 'block';
            menu.style.zIndex = '10000';
        } else {
            // Clear inline styles when closing
            menu.style.visibility = '';
            menu.style.opacity = '';
            menu.style.display = '';
            menu.style.zIndex = '';
        }
    } else {
        console.error('Menu not found!');
    }
    
    return false;
};

window.selectDropdownTab = function(tabName, event) {
    console.log('selectDropdownTab called:', tabName, event);
    
    if (event) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
    }
    
    // Close all dropdowns first
    document.querySelectorAll('.nav-dropdown').forEach(dd => {
        dd.classList.remove('active');
    });
    
    // Small delay to ensure dropdown closes before tab switch
    setTimeout(() => {
    if (typeof switchTab === 'function') {
            console.log('Calling switchTab for:', tabName);
        switchTab(tabName);
    } else {
        console.error('switchTab function not found!');
    }
    }, 10);
    
    return false;
};

// Ensure currentBuySheet is always initialized
function generateBuySheetId() {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `BS-${timestamp}-${random}`;
}

function createEmptyBuySheet() {
    const now = new Date().toISOString();
    return {
        sheetId: generateBuySheetId(),
        createdAt: now,
        lastSavedAt: null,
        status: 'pending',
            customer: '',
            notes: '',
        checkNumber: '',
            items: [],
        contact: {
            phone: '',
            email: '',
            address: '',
            city: '',
            state: '',
            zip: ''
        }
    };
}

function formatDateForDisplay(isoString) {
    if (!isoString) return '—';
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return '—';
    return date.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });
}

function formatRelativeTime(isoString) {
    if (!isoString) return '—';
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return '—';
    const now = new Date();
    const diffMs = now - date;
    if (diffMs < 0) return 'Just now';
    const diffSeconds = Math.floor(diffMs / 1000);
    if (diffSeconds < 30) return 'Just now';
    if (diffSeconds < 60) return `${diffSeconds}s ago`;
    const diffMinutes = Math.floor(diffSeconds / 60);
    if (diffMinutes < 60) return `${diffMinutes}m ago`;
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 30) return `${diffDays}d ago`;
    return formatDateForDisplay(isoString);
}

function getCurrentEventName() {
    if (!currentEvent) return 'Select an event';
    const event = getEvent(currentEvent);
    if (event && event.name) return event.name;

    try {
        const storedEvents = JSON.parse(localStorage.getItem('events') || '[]');
        if (Array.isArray(storedEvents)) {
            const fallback = storedEvents.find(evt => evt.id === currentEvent || evt.tempId === currentEvent);
            if (fallback && fallback.name) {
                return fallback.name;
            }
        }
    } catch (error) {
        console.warn('Unable to read events from localStorage when resolving event name:', error);
    }

    return 'Current Event';
}

function updateBuySheetMetaUI() {
    ensureBuySheet();
    const idEl = document.getElementById('buy-sheet-id');
    if (idEl) {
        idEl.textContent = currentBuySheet.sheetId || '—';
    }

    const dateEl = document.getElementById('buy-sheet-date');
    if (dateEl) {
        dateEl.textContent = formatDateForDisplay(currentBuySheet.createdAt);
    }

    const eventEl = document.getElementById('buy-sheet-event');
    if (eventEl) {
        eventEl.textContent = getCurrentEventName();
    }

    const lastSavedEl = document.getElementById('buy-sheet-last-saved');
    if (lastSavedEl) {
        const relative = formatRelativeTime(currentBuySheet.lastSavedAt);
        lastSavedEl.textContent = currentBuySheet.lastSavedAt ? `Last saved: ${relative}` : 'Last saved: —';
    }
}

function prefillBuySheetContactFromCustomer() {
    ensureBuySheet();
    if (!currentBuySheet.customer) return false;
    const contact = currentBuySheet.contact || {};
    const hasContactInfo = Object.values(contact).some(value => value && value.trim() !== '');
    if (hasContactInfo) return false;

    const customerInfo = getCustomerInfo(currentBuySheet.customer);
    if (!customerInfo) return false;

    currentBuySheet.contact = {
        phone: customerInfo.phone || '',
        email: customerInfo.email || '',
        address: customerInfo.address || '',
        city: customerInfo.city || '',
        state: customerInfo.state || '',
        zip: customerInfo.zip || ''
    };
    return true;
}

function syncBuySheetContactInputs() {
    ensureBuySheet();
    const contact = currentBuySheet.contact || {};
    const isConfirmed = currentBuySheet.status === 'confirmed';
    Object.entries(BUY_SHEET_CONTACT_FIELDS).forEach(([key, elementId]) => {
        const input = document.getElementById(elementId);
        if (!input) return;
        const value = contact[key] || '';
        if (input.value !== value) {
            input.value = value;
        }
        input.disabled = isConfirmed;
    });
}

function persistCurrentBuySheetState() {
    currentBuySheet.lastSavedAt = new Date().toISOString();
    if (currentEvent) {
        localStorage.setItem(`buySheet_${currentEvent}`, JSON.stringify(currentBuySheet));
    }
    updateBuySheetMetaUI();
}

function ensureBuySheet() {
    if (!currentBuySheet) {
        currentBuySheet = createEmptyBuySheet();
    }
    if (!Array.isArray(currentBuySheet.items)) {
        currentBuySheet.items = [];
    }
    currentBuySheet.status = currentBuySheet.status || 'pending';
    currentBuySheet.sheetId = currentBuySheet.sheetId || generateBuySheetId();
    currentBuySheet.createdAt = currentBuySheet.createdAt || new Date().toISOString();
    currentBuySheet.contact = currentBuySheet.contact || {
        phone: '',
        email: '',
        address: '',
        city: '',
        state: '',
        zip: ''
    };
}

// Initialize App
document.addEventListener('DOMContentLoaded', async () => {
    // Initialize authentication first
    await initAuth();
    
    // Set up auth form listeners
    const loginForm = document.getElementById('login-form');
    const signupForm = document.getElementById('signup-form');
    if (loginForm) {
        loginForm.addEventListener('submit', handleLogin);
    }
    if (signupForm) {
        signupForm.addEventListener('submit', handleSignup);
    }
    
    // Only initialize app if authenticated
    if (currentUser) {
        showApp();
    }
});

async function initializeApp() {
    try {
        // Set up event listeners first
        setupEventListeners();
        
        // Load events and populate selector
        await loadEvents();
        
        // Set default date
        setDefaultDate();
        
        // Initialize dashboard overview (show all events combined)
        updateDashboardOverview(null, [], []);
        
        // Make sure event selector is populated (reload in case it wasn't)
        await loadEvents();
        
        // Adjust main content margin for fixed navbar
        adjustMainContentMargin();
    } catch (error) {
        console.error('Error initializing app:', error);
        // Still try to set up basic UI even if there's an error
        setupEventListeners();
        await loadEvents(); // Try to load events even on error
        adjustMainContentMargin();
    }
}

function adjustMainContentMargin() {
    // Top navbar + tabs layout
    const navbar = document.querySelector('.navbar');
    const tabs = document.querySelector('.tabs');
    const mainContent = document.querySelector('.main-content');
    
    if (navbar && tabs && mainContent) {
        // Ensure navbar is visible and on top
        navbar.style.display = 'block';
        navbar.style.visibility = 'visible';
        navbar.style.opacity = '1';
        navbar.style.position = 'fixed';
        navbar.style.top = '0';
        navbar.style.left = '0';
        navbar.style.right = '0';
        navbar.style.width = '100%';
        navbar.style.zIndex = '1000';
        
        // Calculate actual heights
        const navbarRect = navbar.getBoundingClientRect();
        const navbarHeight = navbarRect.height;
        
        // Update tabs position based on actual navbar height
        tabs.style.top = `${navbarHeight}px`;
        tabs.style.position = 'fixed';
        tabs.style.left = '0';
        tabs.style.right = '0';
        tabs.style.zIndex = '999';
        
        const tabsRect = tabs.getBoundingClientRect();
        const tabsHeight = tabsRect.height;
        
        const totalHeight = navbarHeight + tabsHeight + 20;
        
        mainContent.style.marginTop = `${totalHeight}px`;
        mainContent.style.marginLeft = '0';
    }
}

// Adjust on window resize
window.addEventListener('resize', () => {
    adjustMainContentMargin();
});

// Also adjust after load
window.addEventListener('load', () => {
    adjustMainContentMargin();
});
// Event Listeners Setup
function setupEventListeners() {
    // Tab Navigation (only direct tab buttons, not dropdown toggles)
    document.querySelectorAll('.tab-btn:not(.dropdown-toggle)').forEach(btn => {
        // Remove any existing listeners to prevent duplicates
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
        
        newBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const tab = newBtn.dataset.tab;
            console.log('Tab button clicked:', tab);
            if (tab) {
                switchTab(tab);
            }
        });
    });
    
    // Dropdown Navigation - set up after DOM is ready
    setTimeout(() => {
        console.log('Setting up dropdowns...');
        const toggles = document.querySelectorAll('.dropdown-toggle');
        console.log('Found dropdown toggles:', toggles.length);
        
        // Set up dropdown toggles
        toggles.forEach(toggle => {
            toggle.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                console.log('Dropdown toggle clicked:', this);
                const dropdown = this.closest('.nav-dropdown');
                
                if (!dropdown) {
                    console.error('Dropdown container not found');
                    return;
                }
                
                console.log('Dropdown container found:', dropdown);
                
                // Close all other dropdowns
                document.querySelectorAll('.nav-dropdown').forEach(dd => {
                    if (dd !== dropdown) {
                        dd.classList.remove('active');
                    }
                });
                
                // Toggle current dropdown
                const wasActive = dropdown.classList.contains('active');
                dropdown.classList.toggle('active');
                const isNowActive = dropdown.classList.contains('active');
                console.log('Dropdown toggled. Was active:', wasActive, 'Now active:', isNowActive);
                
                // Check if menu exists
                const menu = dropdown.querySelector('.dropdown-menu');
                console.log('Menu element:', menu);
                if (menu) {
                    console.log('Menu styles:', window.getComputedStyle(menu));
                }
            });
        });
        
        // Set up dropdown items
        const items = document.querySelectorAll('.dropdown-item');
        console.log('Found dropdown items:', items.length);
        items.forEach(item => {
            item.addEventListener('click', function(e) {
                e.stopPropagation();
                e.preventDefault();
                const tab = this.dataset.tab;
                console.log('Dropdown item clicked:', tab);
                if (tab) {
                    switchTab(tab);
                    // Close dropdown after selection
                    const parentDropdown = this.closest('.nav-dropdown');
                    if (parentDropdown) {
                        parentDropdown.classList.remove('active');
                    }
                }
            });
        });
    }, 200);
    
    // Close dropdowns when clicking outside (with delay to avoid conflicts)
    setTimeout(() => {
        document.addEventListener('click', (e) => {
            // Don't close if clicking on dropdown toggle or item
            if (e.target.closest('.dropdown-toggle') || e.target.closest('.dropdown-item')) {
                return;
            }
            
            // Close all dropdowns if clicking outside
            if (!e.target.closest('.nav-dropdown')) {
                document.querySelectorAll('.nav-dropdown').forEach(dd => {
                    dd.classList.remove('active');
                });
            }
        });
    }, 300);

    // Calculator
    document.getElementById('calc-calculate-btn').addEventListener('click', calculateMetal);
    document.getElementById('calc-send-btn').addEventListener('click', sendToBuySheet);
    document.getElementById('calc-clear-btn').addEventListener('click', clearCalculator);
    const refreshPricesBtn = document.getElementById('refresh-prices-btn');
    if (refreshPricesBtn) {
        refreshPricesBtn.style.display = '';
        if (!refreshPricesBtn.dataset.bound) {
            refreshPricesBtn.addEventListener('click', () => {
                fetchPreciousMetalPrices({ force: true });
            });
            refreshPricesBtn.dataset.bound = 'true';
        }
    }
    const livePricesDisplay = document.getElementById('live-prices-display');
    if (livePricesDisplay) {
        livePricesDisplay.style.display = 'none';
    }
    fetchPreciousMetalPrices().catch(error => {
        console.error('Initial precious metal price load failed:', error);
    });
    
    // Auto-update calculator when metal type changes
    const calcMetalSelect = document.getElementById('calc-metal');
    if (calcMetalSelect) {
        calcMetalSelect.addEventListener('change', () => {
            updateCalculatorMarketPrice({ triggerRecalculate: false, force: true });
            if (shouldAutoCalculate()) {
                calculateMetal();
            }
        });
    }

    const calcMarketPriceInput = document.getElementById('calc-market-price');
    if (calcMarketPriceInput) {
        calcMarketPriceInput.addEventListener('input', () => {
            calcMarketPriceInput.dataset.autoFilled = 'false';
        });
    }
    
    // Auto-fill today's date
    const calcDateInput = document.getElementById('calc-date');
    if (calcDateInput && !calcDateInput.value) {
        calcDateInput.value = new Date().toISOString().split('T')[0];
    }
    // Slider for offer percentage
    const offerPctSlider = document.getElementById('calc-offer-pct');
    const offerPctDisplay = document.getElementById('calc-offer-pct-display');
    if (offerPctSlider && offerPctDisplay) {
        offerPctSlider.addEventListener('input', (e) => {
            const value = parseInt(e.target.value);
            offerPctDisplay.textContent = `${value}%`;
            // Auto-calculate if all fields are filled
            if (shouldAutoCalculate()) {
                calculateMetal();
            }
        });
    }
    
    // Auto-calculate on input change
    ['calc-metal', 'calc-karat', 'calc-weight', 'calc-market-price', 'calc-offer-pct'].forEach(id => {
        const input = document.getElementById(id);
        if (input) {
            input.addEventListener('input', () => {
                if (shouldAutoCalculate()) {
                    calculateMetal();
                }
            });
        }
    });

    // Buy Sheet
    document.getElementById('buy-sheet-confirm-btn').addEventListener('click', confirmBuySheet);
    document.getElementById('buy-sheet-cancel-btn').addEventListener('click', cancelBuySheet);
    document.getElementById('buy-sheet-customer').addEventListener('input', saveBuySheet);
    document.getElementById('buy-sheet-notes').addEventListener('input', saveBuySheet);
    Object.entries(BUY_SHEET_CONTACT_FIELDS).forEach(([key, elementId]) => {
        const field = document.getElementById(elementId);
        if (field) {
            field.addEventListener('input', () => {
                ensureBuySheet();
                currentBuySheet.contact = currentBuySheet.contact || {};
                currentBuySheet.contact[key] = field.value;
                saveBuySheet();
            });
        }
    });
    const addItemInlineBtn = document.getElementById('buy-sheet-add-inline');
    if (addItemInlineBtn) {
        const inlineHandler = typeof handleBuySheetAddItem === 'function' ? handleBuySheetAddItem : openAddItemToSheetModal;
        addItemInlineBtn.addEventListener('click', (event) => {
            if (typeof inlineHandler === 'function') {
                inlineHandler(event);
            }
        });
    }
    const addItemModalBtn = document.getElementById('add-item-to-sheet-btn');
    if (addItemModalBtn) {
        addItemModalBtn.addEventListener('click', openAddItemToSheetModal);
    }
    const addItemForm = document.getElementById('add-item-to-sheet-form');
    if (addItemForm) {
        addItemForm.addEventListener('submit', addItemToBuySheet);
    }

    // Event Management
    const newEventBtn = document.getElementById('new-event-btn');
    if (newEventBtn) {
        newEventBtn.addEventListener('click', openNewEventModal);
    } else {
        console.warn('setupEventListeners: missing element #new-event-btn');
    }

    const eventSelector = document.getElementById('event-selector');
    if (eventSelector) {
        eventSelector.addEventListener('change', loadEvent);
    } else {
        console.warn('setupEventListeners: missing element #event-selector');
    }

    const newEventForm = document.getElementById('new-event-form');
    if (newEventForm) {
        newEventForm.addEventListener('submit', createNewEvent);
    } else {
        console.warn('setupEventListeners: missing element #new-event-form');
    }

    // Sales
    document.getElementById('add-sale-btn').addEventListener('click', openAddSaleModal);
    document.getElementById('add-sale-form').addEventListener('submit', addSale);
    document.getElementById('sale-buy-item').addEventListener('change', onSaleItemSelected);

    // Expenses
    document.getElementById('add-expense-btn').addEventListener('click', openAddExpenseModal);
    document.getElementById('add-expense-form').addEventListener('submit', addExpense);

    // Appointments
    document.getElementById('refresh-appointments-btn').addEventListener('click', loadCalendlyAppointments);
    
    // Calendar navigation
    const prevMonthBtn = document.getElementById('calendar-prev-month');
    const nextMonthBtn = document.getElementById('calendar-next-month');
    
    if (prevMonthBtn) {
        prevMonthBtn.addEventListener('click', () => {
            calendarState.currentMonth--;
            if (calendarState.currentMonth < 0) {
                calendarState.currentMonth = 11;
                calendarState.currentYear--;
            }
            // Combine all appointments for calendar display (deduplicated)
            const combinedAppointments = getCombinedAppointments();
            renderAppointmentsCalendar(combinedAppointments);
        });
    }
    
    if (nextMonthBtn) {
        nextMonthBtn.addEventListener('click', () => {
            calendarState.currentMonth++;
            if (calendarState.currentMonth > 11) {
                calendarState.currentMonth = 0;
                calendarState.currentYear++;
            }
            // Combine all appointments for calendar display (deduplicated)
            const combinedAppointments = getCombinedAppointments();
            renderAppointmentsCalendar(combinedAppointments);
        });
    }
    document.querySelectorAll('#appointments .filter-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('#appointments .filter-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            const filter = e.target.dataset.filter;
            filterAppointments(filter);
        });
    });
    
    // Load appointments on tab switch (handle both regular buttons and dropdown items)
    document.addEventListener('click', (e) => {
        const tab = e.target.dataset.tab;
        if (tab === 'appointments') {
            loadCalendlyAppointments();
        }
    });

    // Market Research / Event Planning
    const marketResearchForm = document.getElementById('market-research-form');
    if (marketResearchForm) {
        marketResearchForm.addEventListener('submit', searchMarketResearch);
    }
    
    // Wizard Market Research Form
    const wizardMarketResearchForm = document.getElementById('wizard-market-research-form');
    if (wizardMarketResearchForm) {
        wizardMarketResearchForm.addEventListener('submit', searchWizardMarketResearch);
    }
    
    // Search type tabs (both regular and wizard)
    document.querySelectorAll('.search-tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const searchType = e.target.dataset.searchType;
            const form = e.target.closest('form');
            if (form && form.id === 'wizard-market-research-form') {
                switchWizardSearchType(searchType);
            } else {
                switchSearchType(searchType);
            }
        });
    });
    
    // Event Planner buttons
    const createEventBtn = document.getElementById('create-event-btn');
    if (createEventBtn) {
        createEventBtn.addEventListener('click', startWizard);
    }
    
    const wizardCompleteForm = document.getElementById('wizard-complete-form');
    if (wizardCompleteForm) {
        wizardCompleteForm.addEventListener('submit', saveWizardEvent);
    }
    
    const venueSearchInput = document.getElementById('venue-search');
    if (venueSearchInput) {
        venueSearchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                searchVenue();
            }
        });
    }
    
    // Load event list on page load
    loadEventList();
    
    // CRM Management
    const crmRefreshBtn = document.getElementById('crm-refresh-btn');
    if (crmRefreshBtn) {
        crmRefreshBtn.addEventListener('click', () => renderCRMManagement());
    }
    const crmCustomersTbody = document.getElementById('crm-customers-tbody');
    if (crmCustomersTbody) {
        crmCustomersTbody.addEventListener('click', handleCRMRowClick);
    }
    const crmSearchInput = document.getElementById('crm-search-input');
    if (crmSearchInput) {
        crmSearchInput.addEventListener('input', (e) => {
            crmState.searchQuery = e.target.value.trim().toLowerCase();
            renderCRMManagement();
        });
    }

    // Buy List - Add Item
    document.getElementById('add-item-btn').addEventListener('click', openAddItemModal);
    document.getElementById('add-item-form').addEventListener('submit', addItemToBuyList);

    // P/L
    document.getElementById('recalculate-pl-btn').addEventListener('click', recalculatePL);
    document.getElementById('export-report-btn').addEventListener('click', exportReport);

    // Settings
    const saveProfileBtn = document.getElementById('save-profile-btn');
    if (saveProfileBtn) {
        saveProfileBtn.addEventListener('click', saveProfile);
    }
    
    // Initialize profile picture upload (will be re-initialized when Settings tab opens)
    initProfilePictureUpload();
    
    const addAdminBtn = document.getElementById('add-admin-btn');
    const addAdminForm = document.getElementById('add-admin-form');
    if (addAdminBtn) {
        addAdminBtn.addEventListener('click', () => {
            document.getElementById('add-admin-modal').style.display = 'flex';
        });
    }
    if (addAdminForm) {
        addAdminForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('admin-email').value;
            const name = document.getElementById('admin-name').value;
            const role = document.getElementById('admin-role-select').value;
            await addAdmin(email, name, role);
        });
    }
    
    const addRoleBtn = document.getElementById('add-role-btn');
    const addRoleForm = document.getElementById('add-role-form');
    if (addRoleBtn) {
        addRoleBtn.addEventListener('click', () => {
            document.getElementById('add-role-modal').style.display = 'flex';
        });
    }
    if (addRoleForm) {
        addRoleForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const name = document.getElementById('role-name-input').value;
            const checkboxes = addRoleForm.querySelectorAll('input[name="permissions"]:checked');
            const permissions = Array.from(checkboxes).map(cb => cb.value);
            await addRole(name, permissions);
            addRoleForm.reset();
        });
    }
    
    // Employee Management Event Listeners
    const addEmployeeBtn = document.getElementById('add-employee-btn');
    const addEmployeeForm = document.getElementById('add-employee-form');
    const editEmployeeForm = document.getElementById('edit-employee-form');
    const employeeSearchInput = document.getElementById('employee-search-input');
    
    if (addEmployeeBtn) {
        addEmployeeBtn.addEventListener('click', () => {
            document.getElementById('add-employee-modal').style.display = 'flex';
        });
    }
    
    if (addEmployeeForm) {
        addEmployeeForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('employee-email').value;
            const name = document.getElementById('employee-name').value;
            const role = document.getElementById('employee-role-select').value;
            await addEmployee(email, name, role);
            addEmployeeForm.reset();
        });
    }
    
    // Employee form listeners will be initialized when Settings tab is opened
    // (via loadSettings -> initEmployeeFormListeners)
    // This prevents duplicate listeners from being attached multiple times
    
    if (employeeSearchInput) {
        employeeSearchInput.addEventListener('input', (e) => {
            filterEmployees(e.target.value);
        });
    }
    // Logout button event listener (ensure it works even if onclick fails)
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        // Add event listener (works alongside onclick)
        logoutBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('Logout button clicked via event listener');
            if (typeof window.handleLogout === 'function') {
                window.handleLogout();
            } else {
                console.error('handleLogout function not found!');
                alert('Logout function not available. Please refresh the page.');
            }
        });
        console.log('Logout button event listener attached');
    } else {
        console.warn('Logout button not found during setup');
    }

    // Dashboard Filters
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            updateDashboard();
        });
    });

    // Modal Closes
    // Close button handlers - handle inline onclick handlers too
    document.querySelectorAll('.close, .close-modal').forEach(btn => {
        // Only add listener if not already has onclick
        if (!btn.onclick) {
            btn.addEventListener('click', (e) => {
                const modal = e.target.closest('.modal');
                if (modal) {
                    modal.style.display = 'none';
                }
            });
        }
    });

    window.addEventListener('click', (e) => {
        if (e.target.classList.contains('modal')) {
            closeModals();
        }
    });
}

// Tab Management
function switchTab(tabName) {
    console.log('switchTab called with:', tabName);
    
    // Hide all tab contents
    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.classList.remove('active');
        tab.style.display = 'none'; // Also explicitly hide
        // Ensure Reports tab content is also hidden when switching away
        if (tab.id === 'reports') {
            const reportsContent = tab.querySelector('#reports-content');
            if (reportsContent && tabName !== 'reports') {
                reportsContent.style.display = 'none';
            }
        }
    });
    
    // Remove active class from all tab buttons (including dropdown toggles)
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    
    // Remove active class from all dropdown items
    document.querySelectorAll('.dropdown-item').forEach(item => {
        item.classList.remove('active');
    });
    
    // Show selected tab content
    const selectedTab = document.getElementById(tabName);
    if (selectedTab) {
        console.log('Found tab element:', selectedTab);
        selectedTab.classList.add('active');
        selectedTab.style.display = 'block'; // Explicitly show
    } else {
        console.error('Tab element not found for:', tabName);
    }
    
    // Add active class to selected tab button (if it's a direct button, not a dropdown toggle)
    const selectedBtn = document.querySelector(`.tab-btn[data-tab="${tabName}"]:not(.dropdown-toggle)`);
    if (selectedBtn) {
        selectedBtn.classList.add('active');
    }
    
    // Add active class to dropdown item if it exists
    const selectedDropdownItem = document.querySelector(`.dropdown-item[data-tab="${tabName}"]`);
    if (selectedDropdownItem) {
        selectedDropdownItem.classList.add('active');
        // Also highlight the parent dropdown toggle
        const parentDropdown = selectedDropdownItem.closest('.nav-dropdown');
        if (parentDropdown) {
            const toggle = parentDropdown.querySelector('.dropdown-toggle');
            if (toggle) {
                toggle.classList.add('active');
            }
        }
    }

    // Update event selector if needed (only for event-specific tabs)
    // Customers, Event Planning, Settings, and Appointments don't need event selector
    if (tabName === 'dashboard' || tabName === 'buy-list' || tabName === 'sales' || tabName === 'expenses' || tabName === 'reports') {
        if (typeof renderEventSelector === 'function') {
        renderEventSelector();
        } else {
            console.warn('renderEventSelector is not defined; skipping event selector refresh.');
        }
    }
    
    // Load data for specific tabs
    // Note: Customers, Event Planning, Settings, and Appointments work without an event selected
    if (tabName === 'dashboard') {
        updateDashboard(); // This will also call updateWelcomeMessage()
    } else if (tabName === 'reports') {
        // Ensure the Reports tab is visible
        const reportsTab = document.getElementById('reports');
        if (reportsTab) {
            reportsTab.style.display = 'block';
            // Show the content when Reports tab is active
            const reportsContent = document.getElementById('reports-content');
            if (reportsContent) {
                reportsContent.style.display = 'block';
            }
        }
        // Calculate P/L now that tab is active
        recalculatePL();
    } else if (tabName === 'buy-list') {
        renderBuyList();
    } else if (tabName === 'sales') {
        renderSales();
    } else if (tabName === 'expenses') {
        renderExpenses();
    } else if (tabName === 'crm-management') {
        renderCRMManagement();
    } else if (tabName === 'event-planning') {
        // Load event list when Event Planning tab is opened
        loadEventList();
    } else if (tabName === 'appointments') {
        // Check if day has changed and refresh appointments
        checkDayChangeAndRefreshAppointments();
        
        // Load appointments and initialize route planner when Appointments tab is opened
        if (typeof loadCalendlyAppointments === 'function') {
            loadCalendlyAppointments();
        }
        initializeRoutePlanner();
    } else if (tabName === 'settings') {
        // Load settings when Settings tab is opened
        loadSettings();
    }
}
// Precious Metal Calculator
function calculateMetal() {
    const metal = document.getElementById('calc-metal').value;
    const karat = document.getElementById('calc-karat').value;
    const weight = parseFloat(document.getElementById('calc-weight').value);
    const marketPricePerOunce = parseFloat(document.getElementById('calc-market-price').value);
    // Slider value is 0-100, convert to 0-1
    const offerPct = parseFloat(document.getElementById('calc-offer-pct').value) / 100;

    if (!metal || !karat || !weight || !marketPricePerOunce || !offerPct) {
        alert('Please fill in all fields');
        return;
    }

    // Convert price per ounce to price per gram
    // 1 ounce = 31.1035 grams (troy ounce for precious metals)
    const marketPricePerGram = marketPricePerOunce / 31.1035;

    // Calculate purity percentage (with half karat back)
    const purity = getPurityPercentage(karat);
    
    // Apply 96% melt efficiency (only 96% of metal is recovered when melting)
    const meltEfficiency = 0.96;
    
    // Calculate melt value:
    // 1. Calculate pure metal content: weight × purity
    // 2. Apply melt efficiency to get recoverable metal: pureMetal × meltEfficiency
    // 3. Calculate value: recoverableMetal × marketPricePerGram
    const pureMetalWeight = weight * purity;
    const recoverableMetalWeight = pureMetalWeight * meltEfficiency;
    const fullMelt = recoverableMetalWeight * marketPricePerGram;
    const offer = fullMelt * offerPct;
    const profit = fullMelt - offer;

    // Display results
    document.getElementById('calc-melt').textContent = formatCurrency(fullMelt);
    document.getElementById('calc-offer').textContent = formatCurrency(offer);
    document.getElementById('calc-profit').textContent = formatCurrency(profit);
    
    // Display breakdown
    document.getElementById('calc-purity').textContent = `${(purity * 100).toFixed(2)}%`;
    document.getElementById('calc-pure-weight').textContent = `${pureMetalWeight.toFixed(2)}g`;
    document.getElementById('calc-recoverable-weight').textContent = `${recoverableMetalWeight.toFixed(2)}g`;
    document.getElementById('calc-price-per-gram').textContent = formatCurrency(marketPricePerGram);

    // Enable send button
    document.getElementById('calc-send-btn').disabled = false;

    // Store calculation data (store per gram price for consistency)
    // Category will be determined when adding to buy sheet based on metal type
    // Note: profit is NOT stored here - it will be set to 0 when added to buy list
    document.getElementById('calc-send-btn').dataset.calcData = JSON.stringify({
        metal,
        karat,
        weight,
        marketPrice: marketPricePerGram, // Store as price per gram
        marketPricePerOunce: marketPricePerOunce, // Also store original ounce price
        offerPct,
        fullMelt,
        offer
        // profit is NOT included - will be set to 0 when added to buy list/sheet
    });
}
// Helper function to check if all required fields are filled for auto-calculation
function shouldAutoCalculate() {
    const metal = document.getElementById('calc-metal').value;
    const karat = document.getElementById('calc-karat').value;
    const weight = parseFloat(document.getElementById('calc-weight').value);
    const marketPricePerOunce = parseFloat(document.getElementById('calc-market-price').value);
    const offerPct = parseFloat(document.getElementById('calc-offer-pct').value);
    
    return metal && karat && weight > 0 && marketPricePerOunce > 0 && offerPct > 0;
}

// Clear calculator function
function clearCalculator() {
    document.getElementById('calculator-form').reset();
    document.getElementById('calc-date').value = new Date().toISOString().split('T')[0];
    document.getElementById('calc-offer-pct').value = 85;
    document.getElementById('calc-offer-pct-display').textContent = '85%';
    
    // Reset results
    document.getElementById('calc-melt').textContent = '$0.00';
    document.getElementById('calc-offer').textContent = '$0.00';
    document.getElementById('calc-profit').textContent = '$0.00';
    document.getElementById('calc-purity').textContent = '-';
    document.getElementById('calc-pure-weight').textContent = '-';
    document.getElementById('calc-recoverable-weight').textContent = '-';
    document.getElementById('calc-price-per-gram').textContent = '-';
    
    // Disable send button
    document.getElementById('calc-send-btn').disabled = true;
    document.getElementById('calc-send-btn').dataset.calcData = '';
}

function getPurityPercentage(karat) {
    // Base purity map
    const purityMap = {
        '24': 1.0,      // 100%
        '22': 0.917,    // 91.7%
        '18': 0.75,     // 75%
        '14': 0.583,    // 58.3%
        '10': 0.417,    // 41.7%
        '925': 0.925,   // 92.5%
        '900': 0.9,     // 90%
        '800': 0.8,     // 80%
        '1': 1.0        // 100%
    };
    
    let basePurity = purityMap[karat] || 1.0;
    
    // Calculate half karat back (0.5 karat = 2.083% of 24K)
    // For karat values (24, 22, 18, 14, 10), subtract 0.5 karat worth
    // For percentage values (925, 900, 800), subtract 0.5% directly
    if (['24', '22', '18', '14', '10'].includes(karat)) {
        // Half karat = 0.5/24 = 0.020833 (2.083%)
        const halfKaratPct = 0.5 / 24;
        basePurity = Math.max(0, basePurity - halfKaratPct);
    } else if (['925', '900', '800'].includes(karat)) {
        // For percentage values, subtract 0.5% (0.005)
        basePurity = Math.max(0, basePurity - 0.005);
    }
    // For '1' (100% pure), subtract half karat
    else if (karat === '1') {
        const halfKaratPct = 0.5 / 24;
        basePurity = Math.max(0, basePurity - halfKaratPct);
    }
    
    return basePurity;
}
function sendToBuySheet() {
    const sendButton = document.getElementById('calc-send-btn');
    const calcPayload = sendButton ? sendButton.dataset.calcData : null;

    if (!calcPayload) {
        alert('Please calculate an offer first.');
        return;
    }

    let calcData;
    try {
        calcData = JSON.parse(calcPayload);
    } catch (error) {
        console.error('Unable to parse calculator data:', error);
        alert('Please recalculate the offer before sending to the buy sheet.');
        return;
    }
    
    if (!currentEvent) {
        alert('Please select or create an event first');
        return;
    }

    ensureBuySheet();
    
    if (currentBuySheet.status === 'confirmed') {
        alert('Current buy sheet is already confirmed. Please cancel it first.');
        return;
    }

    // Determine category based on metal type
    let category = 'Other';
    if (calcData.metal === 'Gold') {
        category = 'Gold Jewelry';
    } else if (calcData.metal === 'Silver') {
        category = 'Silver Jewelry';
    } else if (calcData.metal === 'Platinum') {
        category = 'Platinum';
    } else if (calcData.metal === 'Palladium') {
        category = 'Palladium';
    }

    // Create description for metal items
    const description = calcData.description || `${calcData.metal} ${calcData.karat}K`;
    
    const item = {
        id: Date.now(),
        category: category,
        ...calcData,
        description: description, // Add description for metal items
        quantity: 1, // Default quantity for metal items (can be updated later)
        profit: 0, // Set profit to 0 until item is actually sold
        isNonMetal: false, // Explicitly mark as metal item
        datePurchased: new Date().toISOString().split('T')[0]
    };

    currentBuySheet.items.push(item);
    renderBuySheet();
    saveBuySheet();

    // Reset calculator
    document.getElementById('calculator-form').reset();
    document.getElementById('calc-melt').textContent = '$0.00';
    document.getElementById('calc-offer').textContent = '$0.00';
    document.getElementById('calc-profit').textContent = '$0.00';
    document.getElementById('calc-send-btn').disabled = true;

    alert('Item added to buy sheet!');
}
// Buy Sheet Management
function renderBuySheet() {
    ensureBuySheet();

    const contactPrefilled = prefillBuySheetContactFromCustomer();
    const status = currentBuySheet.status || 'pending';
    const items = Array.isArray(currentBuySheet.items) ? currentBuySheet.items : [];

    const customerInput = document.getElementById('buy-sheet-customer');
    if (customerInput) {
        customerInput.value = currentBuySheet.customer || '';
        customerInput.disabled = status === 'confirmed';
    }

    const notesInput = document.getElementById('buy-sheet-notes');
    if (notesInput) {
        notesInput.value = currentBuySheet.notes || '';
        notesInput.disabled = status === 'confirmed';
    }

    const statusBadge = document.getElementById('buy-sheet-status');
    if (statusBadge) {
        statusBadge.textContent = status === 'confirmed' ? 'Confirmed' : 'Pending';
        statusBadge.className = `status-badge ${status === 'confirmed' ? 'status-confirmed' : 'status-pending'}`;
    }

    const lockIndicator = document.getElementById('buy-sheet-lock-indicator');
    if (lockIndicator) {
        if (status === 'confirmed') {
            lockIndicator.classList.remove('hidden');
        } else {
            lockIndicator.classList.add('hidden');
        }
    }

    const addItemBtn = document.getElementById('buy-sheet-add-inline') || document.getElementById('add-item-to-sheet-btn');
    if (addItemBtn) {
        addItemBtn.disabled = status === 'confirmed';
    }

    syncBuySheetContactInputs();

    const tableBody = document.getElementById('buy-sheet-table-body');
    if (tableBody) {
        if (items.length === 0) {
            tableBody.innerHTML = `
                <tr class="empty-row">
                    <td colspan="7">
                        <div class="empty-message">
                            <p>No items yet. Click “Add Item” to get started.</p>
                        </div>
                    </td>
                </tr>
            `;
    } else {
            tableBody.innerHTML = items.map((item, index) => {
                const category = item.category || (item.isNonMetal ? 'Item' : 'Metal');
                const description = item.description || (item.isNonMetal ? '' : `${item.metal || ''} ${item.karat ? `${item.karat}K` : ''}`.trim());
                const offer = typeof item.offer === 'number' ? item.offer : parseFloat(item.offer) || 0;
                const meltValue = getItemMeltOrResaleValue(item);
                const profitValue = getItemProfitValue(item, meltValue, offer);
                const profitClass = profitValue < 0 ? 'profit-negative' : 'profit-positive';
                const actions = status === 'confirmed'
                    ? '<span class="text-muted">Locked</span>'
                    : `<button class="btn-secondary btn-sm" onclick="removeBuySheetItem(${item.id})">Remove</button>`;

                return `
                    <tr class="buy-sheet-row ${status === 'confirmed' ? 'locked' : ''}">
                        <td>${index + 1}</td>
                        <td>${escapeHtml(category)}</td>
                        <td>${escapeHtml(description || '—')}</td>
                        <td>${formatCurrency(offer)}</td>
                        <td>${formatCurrency(meltValue)}</td>
                        <td class="${profitClass}">${formatCurrency(profitValue)}</td>
                        <td>${actions}</td>
                    </tr>
                `;
            }).join('');
        }
    } else {
        // Legacy fallback (older markup)
        const legacyList = document.getElementById('buy-sheet-items-list');
        if (legacyList) {
            if (items.length === 0) {
                legacyList.innerHTML = '<p class="empty-message">No items added yet. Use the Calculator for precious metals or click "Add Item" for non-metal items.</p>';
            } else {
                legacyList.innerHTML = items.map(item => {
            if (item.isNonMetal) {
                return `
                    <div class="buy-sheet-item">
                        <div class="buy-sheet-item-info">
                                    <strong>${escapeHtml(item.category || 'Item')}${item.description ? ' - ' + escapeHtml(item.description) : ''}</strong>
                            <div>Offer: ${formatCurrency(item.offer)}</div>
                        </div>
                                ${status === 'pending' ? `
                            <div class="buy-sheet-item-actions">
                                <button class="btn-secondary" onclick="removeBuySheetItem(${item.id})">Remove</button>
                            </div>
                        ` : ''}
                    </div>
                `;
                    }

                    const melt = formatCurrency(item.fullMelt || 0);
                    const offer = formatCurrency(item.offer || 0);
                    const profit = formatCurrency(item.profit || 0);
                return `
                    <div class="buy-sheet-item">
                        <div class="buy-sheet-item-info">
                                <strong>${escapeHtml(item.category || 'Metal')} - ${escapeHtml(item.metal || '')} (${item.karat || ''}K/${(getPurityPercentage(item.karat) * 100).toFixed(1)}%)</strong>
                                <div>Weight: ${item.weight || 0}g | Melt: ${melt} | Offer: ${offer} | Profit: ${profit}</div>
                        </div>
                            ${status === 'pending' ? `
                            <div class="buy-sheet-item-actions">
                                <button class="btn-secondary" onclick="removeBuySheetItem(${item.id})">Remove</button>
                            </div>
                        ` : ''}
                    </div>
                `;
        }).join('');
            }
        }
    }

    const confirmBtn = document.getElementById('buy-sheet-confirm-btn');
    if (confirmBtn) {
        confirmBtn.disabled = items.length === 0 || status === 'confirmed';
    }

    updateBuySheetTotals();
    updateBuySheetMetaUI();
    if (contactPrefilled) {
        persistCurrentBuySheetState();
    }
}

function getItemMeltOrResaleValue(item) {
    const fields = ['fullMelt', 'meltValue', 'resaleValue', 'referenceValue', 'customValue', 'valuation'];
    for (const field of fields) {
        const value = item && typeof item[field] === 'number' ? item[field] : parseFloat(item?.[field] ?? '');
        if (!isNaN(value)) {
            return value;
        }
    }
    return 0;
}

function getItemProfitValue(item, meltValue, offerValue) {
    if (item && typeof item.profit === 'number' && !isNaN(item.profit)) {
        return item.profit;
    }
    const offer = typeof offerValue === 'number' && !isNaN(offerValue) ? offerValue : 0;
    const melt = typeof meltValue === 'number' && !isNaN(meltValue) ? meltValue : 0;
    return melt - offer;
}

function updateBuySheetTotals() {
    const items = Array.isArray(currentBuySheet.items) ? currentBuySheet.items : [];
    const totals = items.reduce((acc, item) => {
        const offer = typeof item.offer === 'number' ? item.offer : parseFloat(item.offer) || 0;
        const melt = getItemMeltOrResaleValue(item);
        const profit = getItemProfitValue(item, melt, offer);
        acc.offer += offer;
        acc.melt += melt;
        acc.profit += profit;
        return acc;
    }, { offer: 0, melt: 0, profit: 0 });

    const meltEl = document.getElementById('buy-sheet-total-melt');
    if (meltEl) {
        meltEl.textContent = formatCurrency(totals.melt);
    }

    const offerEl = document.getElementById('buy-sheet-total-offer');
    if (offerEl) {
        offerEl.textContent = formatCurrency(totals.offer);
    }

    const profitEl = document.getElementById('buy-sheet-total-profit');
    if (profitEl) {
        profitEl.textContent = formatCurrency(totals.profit);
        profitEl.classList.remove('profit-negative', 'profit-positive');
        if (totals.profit < 0) {
            profitEl.classList.add('profit-negative');
        } else if (totals.profit > 0) {
            profitEl.classList.add('profit-positive');
        }
    }
}

function removeBuySheetItem(itemId) {
    currentBuySheet.items = currentBuySheet.items.filter(item => item.id !== itemId);
    renderBuySheet();
    saveBuySheet();
}

// Add Item to Buy Sheet Directly
function openAddItemToSheetModal() {
    if (!currentEvent) {
        alert('Please select or create an event first');
        return;
    }
    ensureBuySheet();
    if (currentBuySheet.status === 'confirmed') {
        alert('Cannot add items to a confirmed buy sheet. Please cancel it first.');
        return;
    }
    const modal = document.getElementById('add-item-to-sheet-modal');
    if (!modal) {
        console.error('Modal not found: add-item-to-sheet-modal');
        alert('Error: Modal not found. Please refresh the page.');
        return;
    }
    modal.classList.add('active');
}

function addItemToBuySheet(e) {
    e.preventDefault();
    ensureBuySheet();
    
    if (currentBuySheet.status === 'confirmed') {
        alert('Cannot add items to a confirmed buy sheet. Please cancel it first.');
        return;
    }

    // Get form values (for non-metal items)
    const category = document.getElementById('sheet-item-category').value;
    const description = document.getElementById('sheet-item-description').value;
    const offerValue = document.getElementById('sheet-item-offer').value;
    const offer = parseFloat(offerValue);

    // Validate fields
    if (!category || category === '') {
        alert('Please select a category');
        return;
    }

    if (!description || description.trim() === '') {
        alert('Please enter an item description');
        return;
    }

    if (!offerValue || isNaN(offer) || offer <= 0) {
        alert('Please enter a valid offer price');
        return;
    }

    // Ensure currentBuySheet.items exists
    if (!currentBuySheet.items) {
        currentBuySheet.items = [];
    }

    // Get quantity
    const quantityValue = document.getElementById('sheet-item-quantity').value;
    const quantity = parseInt(quantityValue) || 1;

    // Create item (non-metal item - no calculations needed)
    const item = {
        id: Date.now(),
        category: category,
        description: description.trim(),
        quantity: quantity,
        metal: 'N/A',
        karat: 'N/A',
        weight: 0,
        marketPrice: 0,
        offerPct: 0,
        fullMelt: 0, // No melt value for non-metal items
        offer: offer,
        profit: 0, // No profit calculation for non-metal items
        datePurchased: new Date().toISOString().split('T')[0],
        isNonMetal: true // Flag to identify non-metal items
    };

    // Add to buy sheet
    currentBuySheet.items.push(item);
    renderBuySheet();
    saveBuySheet();
    closeModals();
    
    // Reset form
    document.getElementById('add-item-to-sheet-form').reset();
    
    alert('Item added to buy sheet!');
}
async function confirmBuySheet() {
    ensureBuySheet();

    if (currentBuySheet.items.length === 0) {
        alert('Cannot confirm empty buy sheet');
        return;
    }

    if (!currentEvent) {
        alert('Please select or create an event first');
        return;
    }

    // Update buy sheet with form values
    const customerName = document.getElementById('buy-sheet-customer').value.trim();
    if (!customerName) {
        alert('Customer name is required');
        return;
    }
    
    // Save customer name and notes to currentBuySheet (check number will be added in modal)
    currentBuySheet.customer = customerName;
    currentBuySheet.notes = document.getElementById('buy-sheet-notes').value;
    
    // Calculate totals for display in modal
    const totals = currentBuySheet.items.reduce((acc, item) => {
        acc.items += 1;
        acc.offer += Number(item.offer) || 0;
        return acc;
    }, { items: 0, offer: 0 });
    
    // Show confirmation modal
    const itemsLabel = document.getElementById('confirm-total-items');
    if (itemsLabel) {
        itemsLabel.textContent = totals.items;
    }

    const offerLabel = document.getElementById('confirm-total-offer');
    if (offerLabel) {
        offerLabel.textContent = formatCurrency(totals.offer);
    }

    const checkInput = document.getElementById('confirm-check-number');
    if (checkInput) {
        checkInput.value = '';
    }
    
    const modal = document.getElementById('confirm-transaction-modal');
    if (!modal) {
        console.error('Confirm transaction modal not found in DOM.');
        alert('Unable to open confirmation modal. Please reload the page.');
        return;
    }

    modal.style.display = 'flex';
    modal.style.alignItems = 'center';
    modal.style.justifyContent = 'center';
    
    // Focus on check number input
    setTimeout(() => {
        const focusInput = document.getElementById('confirm-check-number');
        if (focusInput) {
            focusInput.focus();
        }
    }, 100);
}

function closeConfirmTransactionModal() {
    const modal = document.getElementById('confirm-transaction-modal');
    if (modal) {
        modal.style.display = 'none';
    }
}

async function proceedWithConfirmation() {
    // Get check number from modal
    const checkNumber = document.getElementById('confirm-check-number').value.trim();
    
    if (!checkNumber) {
        alert('Please enter a check number');
        document.getElementById('confirm-check-number').focus();
        return;
    }
    
    if (await isCheckNumberInUse(checkNumber)) {
        alert(`Check number "${checkNumber}" has already been used. Please provide a unique check number.`);
        document.getElementById('confirm-check-number').focus();
        return;
    }
    
    // Close modal
    closeConfirmTransactionModal();
    
    // Proceed with confirmation
    performTransactionConfirmation(checkNumber).catch(error => {
        console.error('Error in transaction confirmation:', error);
    });
}

async function performTransactionConfirmation(checkNumber) {
    ensureBuySheet();

    // Get customer name from input field (ensure it's current)
    const customerInput = document.getElementById('buy-sheet-customer');
    const customerName = customerInput ? customerInput.value.trim() : (currentBuySheet.customer || '').trim();
    
    if (!customerName) {
        alert('Error: Customer name is required. Please enter a customer name.');
        console.error('Customer name is empty in performTransactionConfirmation');
        return;
    }
    
    // Update buy sheet with check number and ensure customer name is set
    currentBuySheet.checkNumber = checkNumber;
    currentBuySheet.status = 'confirmed';
    currentBuySheet.customer = customerName; // Ensure it's saved
    
    console.log('Confirming transaction for customer:', customerName);
    
    // Save customer CRM information
    const contact = currentBuySheet.contact || {};
    try {
        await saveCustomerInfo(customerName, {
            phone: contact.phone ? contact.phone.trim() : '',
            email: contact.email ? contact.email.trim() : '',
            address: contact.address ? contact.address.trim() : '',
            city: contact.city ? contact.city.trim() : '',
            state: contact.state ? contact.state.trim() : '',
            zip: contact.zip ? contact.zip.trim() : '',
            notes: (currentBuySheet.notes || '').trim()
        });
        console.log('Customer info saved successfully:', customerName);
    } catch (error) {
        console.error('Error saving customer info:', error);
        // Continue with transaction even if customer save fails
    }
    // Create a unique buy sheet ID for this confirmation
    const buySheetId = currentBuySheet.sheetId || generateBuySheetId();
    const buySheetDate = currentBuySheet.createdAt
        ? new Date(currentBuySheet.createdAt).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0];
    // Add items to event buy list
    const event = getEvent(currentEvent);
    if (!event) {
        console.error('Unable to locate selected event in cache/localStorage:', currentEvent);
        alert('Selected event could not be found. Please reload your events and try again.');
        return;
    }

    event.buyList = event.buyList || [];
    currentBuySheet.items.forEach(item => {
        // For metal items, check if we can combine with existing same metal/karat
        if (!item.isNonMetal && item.metal && item.karat) {
            const existingItemIndex = event.buyList.findIndex(existing => {
                if (existing.isNonMetal) return false;
                // Normalize karat for comparison
                const sameMetal = existing.metal === item.metal;
                const sameKarat = String(existing.karat) === String(item.karat);
                const existingCustomer = (existing.customer || '').trim();
                const currentCustomer = currentBuySheet.customer.trim();
                const sameCustomer = !existingCustomer || existingCustomer === currentCustomer;
                return sameMetal && sameKarat && sameCustomer;
            });
            
            if (existingItemIndex !== -1) {
                // Combine with existing item
                const existingItem = event.buyList[existingItemIndex];
                
                // Store merge history for unmerging
                if (!existingItem.mergeHistory) {
                    // First merge - store existing item's original state
                    existingItem.mergeHistory = [JSON.parse(JSON.stringify(existingItem))];
                }
                // Store the new item's original state
                const itemCopy = JSON.parse(JSON.stringify(item));
                existingItem.mergeHistory.push(itemCopy);
                
                existingItem.weight += item.weight;
                existingItem.fullMelt += item.fullMelt;
                existingItem.offer += item.offer;
                // Combine quantities
                existingItem.quantity = (existingItem.quantity || 1) + (item.quantity || 1);
                // Ensure isNonMetal is set correctly
                existingItem.isNonMetal = false;
                // Preserve description if the new item has a custom description (not auto-generated)
                if (item.description && item.description !== `${item.metal} ${item.karat}K`) {
                    // If existing item has no description or auto-generated one, use the new one
                    if (!existingItem.description || existingItem.description === `${existingItem.metal} ${existingItem.karat}K`) {
                        existingItem.description = item.description;
                    } else {
                        // Both have descriptions - keep existing but could append
                        existingItem.description = existingItem.description;
                    }
                }
                // Don't update profit or soldWeight - keep existing values
                // New weight is added to total, but soldWeight stays the same (so new weight is available)
                // Keep the most recent customer and notes if they exist (same customer only)
                if (currentBuySheet.customer) {
                    existingItem.customer = currentBuySheet.customer;
                }
                // Track this buy sheet ID (even if item is combined, we track the source buy sheet)
                if (!existingItem.buySheetIds) {
                    existingItem.buySheetIds = [];
                }
                if (!existingItem.buySheetIds.includes(buySheetId)) {
                    existingItem.buySheetIds.push(buySheetId);
                }
                existingItem.buySheetId = buySheetId;
                existingItem.notes = currentBuySheet.notes || existingItem.notes || null;
                existingItem.checkNumber = currentBuySheet.checkNumber || existingItem.checkNumber || null;
                existingItem.customerPhone = contact.phone || existingItem.customerPhone || null;
                existingItem.customerEmail = contact.email || existingItem.customerEmail || null;
                existingItem.customerAddress = contact.address || existingItem.customerAddress || null;
                existingItem.customerCity = contact.city || existingItem.customerCity || null;
                existingItem.customerState = contact.state || existingItem.customerState || null;
                existingItem.customerZip = contact.zip || existingItem.customerZip || null;
            } else {
                // Add as new item - set profit to 0 regardless of calculated profit
                event.buyList.push({
                    ...item,
                    profit: 0, // Set profit to 0 until item is actually sold
                    isNonMetal: false, // Explicitly mark as metal item
                    customer: currentBuySheet.customer,
                    notes: currentBuySheet.notes,
                    checkNumber: currentBuySheet.checkNumber, // Store check number
                    buySheetId: buySheetId, // Track which buy sheet this came from
                    buySheetIds: [buySheetId],
                    datePurchased: buySheetDate,
                    customerPhone: contact.phone || null,
                    customerEmail: contact.email || null,
                    customerAddress: contact.address || null,
                    customerCity: contact.city || null,
                    customerState: contact.state || null,
                    customerZip: contact.zip || null
                });
            }
        } else {
            // Non-metal items or items without metal/karat - add as separate entry
            event.buyList.push({
                ...item,
                profit: 0, // Set profit to 0 until item is actually sold
                customer: currentBuySheet.customer,
                notes: currentBuySheet.notes,
                checkNumber: currentBuySheet.checkNumber, // Store check number
                buySheetId: buySheetId, // Track which buy sheet this came from
                buySheetIds: [buySheetId],
                datePurchased: buySheetDate,
                customerPhone: contact.phone || null,
                customerEmail: contact.email || null,
                customerAddress: contact.address || null,
                customerCity: contact.city || null,
                customerState: contact.state || null,
                customerZip: contact.zip || null
            });
        }
    });

    await saveEvent(event);

    // Reset buy sheet
    currentBuySheet = createEmptyBuySheet();
    renderBuySheet();
    saveBuySheet();
    renderBuyList();
    updateDashboard();
    refreshCRMIfActive(customerName);
    alert('Transaction confirmed! Items added to Buy List.');
}

function cancelBuySheet() {
    if (confirm('Are you sure you want to cancel this buy sheet? All items will be lost.')) {
        currentBuySheet = createEmptyBuySheet();
        renderBuySheet();
        saveBuySheet();
    }
}
// Buy List Rendering
function renderBuyList() {
        if (!currentEvent) {
        document.getElementById('buy-list-tbody').innerHTML = '<tr><td colspan="12" class="empty-message">Please select an event first.</td></tr>';
        return;
    }

    const event = getEvent(currentEvent);
    const buyList = event.buyList || [];

    if (buyList.length === 0) {
        document.getElementById('buy-list-tbody').innerHTML = '<tr><td colspan="12" class="empty-message">No confirmed purchases yet.</td></tr>';
        updateBuyListTotals([]);
        return;
    }

    // Group items by category
    const itemsByCategory = {};
    buyList.forEach((item, index) => {
        const category = item.category || 'Other';
        if (!itemsByCategory[category]) {
            itemsByCategory[category] = [];
        }
        itemsByCategory[category].push({ item, index });
    });

    // Build HTML with category headers
    const tbody = document.getElementById('buy-list-tbody');
    let html = '';

    // Sort categories alphabetically
    const sortedCategories = Object.keys(itemsByCategory).sort();

    sortedCategories.forEach(category => {
        const categoryItems = itemsByCategory[category];
        
        // Add category header row
        html += `
            <tr class="category-header">
                <td colspan="12" class="category-header-cell">
                    <strong>${category}</strong>
                </td>
            </tr>
        `;

        // Add items for this category
        categoryItems.forEach(({ item, index }) => {
            // Check if item has merge history
            const hasMergeHistory = item.mergeHistory && Array.isArray(item.mergeHistory) && item.mergeHistory.length > 0;
            
            if (item.isNonMetal) {
                html += `
                    <tr class="buy-list-item-row" draggable="true" data-item-index="${index}" data-item-key="${getItemKey(item)}">
                        <td style="width: 30px; text-align: center;">
                            <button class="btn-secondary" style="padding: 4px 8px; font-size: 12px;" onclick="selectItemForMerge(${index})" title="Select to merge">Select</button>
                        </td>
                        <td>${item.category}</td>
                        <td><strong>${item.description || '-'}</strong></td>
                        <td>-</td>
                        <td>-</td>
                        <td>${item.quantity || 1}</td>
                        <td>-</td>
                        <td>-</td>
                        <td>${formatCurrency(item.offer)}</td>
                        <td>${formatCurrency(item.profit || 0)}<br><small style="color: var(--text-muted);">(Est: N/A)</small></td>
                        <td>${item.datePurchased || '-'}</td>
                        <td>
                            ${hasMergeHistory ? `<button class="btn-secondary" style="background: #10b981; color: white; border-color: #10b981; margin-right: 0.5rem; padding: 6px 12px;" onclick="event.stopPropagation(); event.preventDefault(); unmergeItem(${index})" onmousedown="event.stopPropagation()" title="Unmerge this item (restore ${item.mergeHistory.length + 1} items)">Unmerge</button>` : ''}
                            <button class="btn-secondary" onclick="event.stopPropagation(); event.preventDefault(); editBuyListItem(${index})" onmousedown="event.stopPropagation()">Edit</button>
                            <button class="btn-secondary" onclick="event.stopPropagation(); event.preventDefault(); deleteBuyListItem(${index})" onmousedown="event.stopPropagation()">Delete</button>
                        </td>
                    </tr>
                `;
            } else {
                // Precious metal item
                // Use description if available, otherwise generate from metal and karat
                let description = item.description;
                if (!description || description.trim() === '') {
                    // Generate description from metal and karat
                    if (item.metal && item.karat) {
                        description = `${item.metal} ${item.karat}K`;
                    } else {
                        description = '-';
                    }
                }
                // Check if item has merge history
                const hasMergeHistory = item.mergeHistory && Array.isArray(item.mergeHistory) && item.mergeHistory.length > 0;
                
                html += `
                    <tr class="buy-list-item-row" draggable="true" data-item-index="${index}" data-item-key="${getItemKey(item)}">
                        <td style="width: 30px; text-align: center;">
                            <button class="btn-secondary" style="padding: 4px 8px; font-size: 12px;" onclick="selectItemForMerge(${index})" title="Select to merge">Select</button>
                        </td>
                        <td>${item.category || '-'}</td>
                        <td><strong>${description}</strong></td>
                        <td>${item.metal || '-'}</td>
                        <td>${item.karat ? item.karat + 'K' : '-'}</td>
                        <td>${item.quantity || 1}</td>
                        <td>${item.weight ? item.weight.toFixed(2) : '0.00'}</td>
                        <td>${item.fullMelt ? formatCurrency(item.fullMelt) : '$0.00'}</td>
                        <td>${item.offer ? formatCurrency(item.offer) : '$0.00'}</td>
                        <td>${formatCurrency(item.profit || 0)}<br><small style="color: var(--text-muted);">(Est: ${formatCurrency(getEstimatedProfit(item))})</small></td>
                        <td>${item.datePurchased || '-'}</td>
                        <td>
                            ${hasMergeHistory ? `<button class="btn-secondary" style="background: #10b981; color: white; border-color: #10b981; margin-right: 0.5rem; padding: 6px 12px;" onclick="event.stopPropagation(); event.preventDefault(); unmergeItem(${index})" onmousedown="event.stopPropagation()" title="Unmerge this item (restore ${item.mergeHistory.length + 1} items)">Unmerge</button>` : ''}
                            <button class="btn-secondary" onclick="event.stopPropagation(); event.preventDefault(); editBuyListItem(${index})" onmousedown="event.stopPropagation()">Edit</button>
                            <button class="btn-secondary" onclick="event.stopPropagation(); event.preventDefault(); deleteBuyListItem(${index})" onmousedown="event.stopPropagation()">Delete</button>
                        </td>
                    </tr>
                `;
            }
        });
    });

    tbody.innerHTML = html;

    // Attach drag and drop event listeners after HTML is inserted
    attachDragAndDropListeners();

    updateBuyListTotals(buyList);
}

// Attach drag and drop event listeners to all buy list rows (no longer needed, but keeping function for compatibility)
function attachDragAndDropListeners() {
    // Clear any previous selection
    selectedItemIndex = null;
    const rows = document.querySelectorAll('.buy-list-item-row');
    rows.forEach(row => {
        row.style.backgroundColor = '';
        row.style.border = '';
    });
}

function updateBuyListTotals(buyList) {
    // Calculate totals for metal items
    const metalItems = buyList.filter(item => !item.isNonMetal);
    const totals = metalItems.reduce((acc, item) => {
        acc.weight += item.weight;
        acc.melt += item.fullMelt;
        acc.offer += item.offer;
        acc.profit += (item.profit || 0);
        return acc;
    }, { weight: 0, melt: 0, offer: 0, profit: 0 });

    // Add offer amounts and profit from non-metal items
    const nonMetalItems = buyList.filter(item => item.isNonMetal);
    nonMetalItems.forEach(item => {
        totals.offer += item.offer;
        totals.profit += (item.profit || 0); // Include profit from non-metal items (coins, watches, etc.)
    });

    document.getElementById('buy-list-total-weight').innerHTML = `<strong>${totals.weight.toFixed(2)} g</strong>`;
    document.getElementById('buy-list-total-melt').innerHTML = `<strong>${formatCurrency(totals.melt)}</strong>`;
    document.getElementById('buy-list-total-offer').innerHTML = `<strong>${formatCurrency(totals.offer)}</strong>`;
    document.getElementById('buy-list-total-profit').innerHTML = `<strong>${formatCurrency(totals.profit)}</strong>`;
}

// Get a unique key for an item to determine if items are compatible for merging
function getItemKey(item) {
    if (item.isNonMetal) {
        // For non-metal items, compatibility is based on category and description
        return `${item.category || 'Other'}_${item.description || ''}`;
    } else {
        // For metal items, compatibility is based on category, metal, karat, and description
        return `${item.category || 'Other'}_${item.metal || ''}_${item.karat || ''}_${item.description || ''}`;
    }
}

// Check if two items are compatible (can be merged)
function areItemsCompatible(item1, item2) {
    return getItemKey(item1) === getItemKey(item2);
}
// Merge system - click-based instead of drag and drop
let selectedItemIndex = null;
// Select item for merge (click-based system)
function selectItemForMerge(index) {
    if (!currentEvent) {
        alert('Please select an event first');
        return;
    }
    
    const event = getEvent(currentEvent);
    if (!event || !event.buyList || index < 0 || index >= event.buyList.length) {
        alert('Invalid item');
        return;
    }
    
    if (selectedItemIndex === null) {
        // First item selected
        selectedItemIndex = index;
        // Highlight the selected row
        const rows = document.querySelectorAll('.buy-list-item-row');
        rows.forEach((row, i) => {
            const rowIndex = parseInt(row.getAttribute('data-item-index'));
            if (rowIndex === index) {
                row.style.backgroundColor = 'rgba(245, 158, 11, 0.2)';
                row.style.border = '2px solid #f59e0b';
            } else {
                row.style.backgroundColor = '';
                row.style.border = '';
            }
        });
        alert('Item selected. Click "Select" on another compatible item to merge them.');
    } else if (selectedItemIndex === index) {
        // Same item clicked - deselect
        selectedItemIndex = null;
        const rows = document.querySelectorAll('.buy-list-item-row');
        rows.forEach(row => {
            row.style.backgroundColor = '';
            row.style.border = '';
        });
        alert('Selection cleared.');
    } else {
        // Second item selected - try to merge
        const firstItem = event.buyList[selectedItemIndex];
        const secondItem = event.buyList[index];
        
        if (!areItemsCompatible(firstItem, secondItem)) {
            alert('Items must be the same type to merge. Both items must have the same category, description (for non-metal items), or metal type and karat (for metal items).\n\nSelection cleared.');
            selectedItemIndex = null;
            const rows = document.querySelectorAll('.buy-list-item-row');
            rows.forEach(row => {
                row.style.backgroundColor = '';
                row.style.border = '';
            });
            return;
        }
        
        // Confirm merge
        if (!confirm(`Merge these items into a single lot?\n\nThis will combine:\n- Weights/quantities\n- Offer amounts\n- Other properties\n\nThe merged item will keep the earliest date purchased.`)) {
            selectedItemIndex = null;
            const rows = document.querySelectorAll('.buy-list-item-row');
            rows.forEach(row => {
                row.style.backgroundColor = '';
                row.style.border = '';
            });
            return;
        }
        
        // Merge the items
        mergeBuyListItems(selectedItemIndex, index);
        selectedItemIndex = null;
    }
}
// Merge two buy list items
function mergeBuyListItems(sourceIndex, targetIndex) {
    if (!currentEvent) {
        alert('Please select an event first');
        return;
    }
    
    const event = getEvent(currentEvent);
    if (!event || !event.buyList) return;
    
    // Ensure indices are in correct order (target should be the one we keep)
    // But we need to be careful - if we delete source first, indices shift
    const sourceItem = JSON.parse(JSON.stringify(event.buyList[sourceIndex])); // Deep copy
    const targetItem = event.buyList[targetIndex];
    
    // Store merge history for unmerging BEFORE modifying the items
    // Create deep copies to avoid reference issues
    const targetCopy = JSON.parse(JSON.stringify(targetItem));
    const sourceCopy = JSON.parse(JSON.stringify(sourceItem));
    
    // Initialize merge history if it doesn't exist
    if (!targetItem.mergeHistory) {
        // First merge - store target's original state BEFORE any modifications
        targetItem.mergeHistory = [targetCopy];
    }
    // Always store the source item's original state
    targetItem.mergeHistory.push(sourceCopy);
    
    console.log('Merge history stored:', targetItem.mergeHistory.length, 'items', targetItem.mergeHistory);
    
    // Merge properties
    // Combine quantities
    targetItem.quantity = (targetItem.quantity || 1) + (sourceItem.quantity || 1);
    
    if (targetItem.isNonMetal) {
        // For non-metal items, combine offer amounts
        targetItem.offer = (targetItem.offer || 0) + (sourceItem.offer || 0);
        // Keep the profit (if sold, profit is already calculated)
        // If both have profit, use the sum
        targetItem.profit = (targetItem.profit || 0) + (sourceItem.profit || 0);
    } else {
        // For metal items, combine weights and recalculate
        targetItem.weight = (targetItem.weight || 0) + (sourceItem.weight || 0);
        targetItem.offer = (targetItem.offer || 0) + (sourceItem.offer || 0);
        targetItem.fullMelt = (targetItem.fullMelt || 0) + (sourceItem.fullMelt || 0);
        // Combine sold weight if applicable
        targetItem.soldWeight = (targetItem.soldWeight || 0) + (sourceItem.soldWeight || 0);
        // Combine profit
        targetItem.profit = (targetItem.profit || 0) + (sourceItem.profit || 0);
    }
    
    // Merge customer names (if different)
    if (sourceItem.customer && targetItem.customer) {
        const sourceCustomers = sourceItem.customer.split(',').map(c => c.trim());
        const targetCustomers = targetItem.customer.split(',').map(c => c.trim());
        const allCustomers = [...new Set([...targetCustomers, ...sourceCustomers])];
        targetItem.customer = allCustomers.join(', ');
    } else if (sourceItem.customer && !targetItem.customer) {
        targetItem.customer = sourceItem.customer;
    }
    
    // Merge notes (if different)
    if (sourceItem.notes && targetItem.notes && sourceItem.notes !== targetItem.notes) {
        targetItem.notes = `${targetItem.notes}\n${sourceItem.notes}`;
    } else if (sourceItem.notes && !targetItem.notes) {
        targetItem.notes = sourceItem.notes;
    }
    
    // Merge buy sheet IDs
    if (!targetItem.buySheetIds) {
        targetItem.buySheetIds = targetItem.buySheetId ? [targetItem.buySheetId] : [];
    }
    if (sourceItem.buySheetIds) {
        sourceItem.buySheetIds.forEach(id => {
            if (!targetItem.buySheetIds.includes(id)) {
                targetItem.buySheetIds.push(id);
            }
        });
    } else if (sourceItem.buySheetId) {
        if (!targetItem.buySheetIds.includes(sourceItem.buySheetId)) {
            targetItem.buySheetIds.push(sourceItem.buySheetId);
        }
    }
    
    // Keep the earliest date purchased
    if (sourceItem.datePurchased && targetItem.datePurchased) {
        if (new Date(sourceItem.datePurchased) < new Date(targetItem.datePurchased)) {
            targetItem.datePurchased = sourceItem.datePurchased;
        }
    } else if (sourceItem.datePurchased && !targetItem.datePurchased) {
        targetItem.datePurchased = sourceItem.datePurchased;
    }
    
    // Remove the source item (always remove from higher index first to avoid index shifting issues)
    // But since we're removing from the actual array, we need to remove from the higher index first
    if (sourceIndex > targetIndex) {
        event.buyList.splice(sourceIndex, 1);
    } else {
        event.buyList.splice(sourceIndex, 1);
    }
    
    // Save the event
    saveEvent(event);
    
    // Re-render the buy list
    renderBuyList();
    
    // Update totals and P/L
    updateBuyListTotals(event.buyList);
    recalculatePL();
    
    // Check if merge history was saved
    const updatedItem = event.buyList[targetIndex > sourceIndex ? targetIndex - 1 : targetIndex];
    if (updatedItem && updatedItem.mergeHistory && updatedItem.mergeHistory.length > 0) {
        alert(`Items merged successfully! The merged item can now be unmerged (restores ${updatedItem.mergeHistory.length + 1} items).`);
    } else {
        alert('Items merged successfully!');
    }
}

// Unmerge a merged item back into its original parts
function unmergeItem(index) {
    if (!currentEvent) {
        alert('Please select an event first');
        return;
    }
    
    const event = getEvent(currentEvent);
    if (!event || !event.buyList || index < 0 || index >= event.buyList.length) {
        alert('Invalid item index');
        return;
    }
    
    const mergedItem = event.buyList[index];
    
    if (!mergedItem.mergeHistory || mergedItem.mergeHistory.length === 0) {
        alert('This item has not been merged. Nothing to unmerge.');
        return;
    }
    
    if (!confirm(`Unmerge this item back into ${mergedItem.mergeHistory.length + 1} separate items?\n\nThis will restore the original items that were merged together.`)) {
        return;
    }
    
    // Get the merge history (all original items including the base)
    const originalItems = mergedItem.mergeHistory;
    
    // Restore the base item (first in history)
    const baseItem = originalItems[0];
    Object.assign(mergedItem, baseItem);
    
    // Remove merge history from the base item
    delete mergedItem.mergeHistory;
    
    // Add back all the other items that were merged
    for (let i = 1; i < originalItems.length; i++) {
        const restoredItem = JSON.parse(JSON.stringify(originalItems[i]));
        delete restoredItem.mergeHistory; // Clean up any nested merge history
        event.buyList.push(restoredItem);
    }
    
    // Save the event
    saveEvent(event);
    
    // Re-render the buy list
    renderBuyList();
    
    // Update totals and P/L
    updateBuyListTotals(event.buyList);
    recalculatePL();
    
    alert(`Item unmerged successfully! Restored ${originalItems.length} separate items.`);
}
// Make merge and unmerge functions globally accessible
window.selectItemForMerge = selectItemForMerge;
window.unmergeItem = unmergeItem;

function editBuyListItem(index) {
    if (!currentEvent) {
        alert('Please select an event first');
        return;
    }
    
    const event = getEvent(currentEvent);
    if (!event || !event.buyList || index < 0 || index >= event.buyList.length) {
        alert('Invalid item index');
        return;
    }
    
    const item = event.buyList[index];
    
    const newOffer = prompt('Enter new offer price:', item.offer);
    if (newOffer !== null && !isNaN(newOffer) && parseFloat(newOffer) >= 0) {
        item.offer = parseFloat(newOffer);
        // Don't update profit here - profit is only updated when items are sold
        // If item was already sold and we change offer, we should recalculate
        // But for now, keep profit as is (only changes on sale)
        saveEvent(event);
        renderBuyList();
        updateBuyListTotals(event.buyList);
        recalculatePL();
        updateDashboard();
    }
}

function deleteBuyListItem(index) {
    if (!currentEvent) {
        alert('Please select an event first');
        return;
    }
    
    const event = getEvent(currentEvent);
    if (!event || !event.buyList || index < 0 || index >= event.buyList.length) {
        alert('Invalid item index');
        return;
    }
    
    if (confirm('Are you sure you want to delete this item? This action cannot be undone.')) {
        event.buyList.splice(index, 1);
        saveEvent(event);
        renderBuyList();
        updateBuyListTotals(event.buyList);
        recalculatePL();
        updateDashboard();
    }
}

// Add Item to Buy List Directly
function openAddItemModal() {
    if (!currentEvent) {
        alert('Please select or create an event first');
        return;
    }
    document.getElementById('add-item-modal').classList.add('active');
    document.getElementById('item-date').value = new Date().toISOString().split('T')[0];
}
function addItemToBuyList(e) {
    e.preventDefault();
    if (!currentEvent) {
        alert('Please select or create an event first');
        return;
    }

    const event = getEvent(currentEvent);
    event.buyList = event.buyList || [];

    // Get form values
    const customer = document.getElementById('item-customer').value || '';
    const category = document.getElementById('item-category').value;
    const metal = document.getElementById('item-metal').value;
    const karat = document.getElementById('item-karat').value;
    const quantityValue = document.getElementById('item-quantity').value;
    const quantity = parseInt(quantityValue) || 1;
    const weight = parseFloat(document.getElementById('item-weight').value);
    const marketPrice = parseFloat(document.getElementById('item-market-price').value);
    const offerPct = parseFloat(document.getElementById('item-offer-pct').value);
    const datePurchased = document.getElementById('item-date').value;

    // Calculate values
    const purity = getPurityPercentage(karat);
    const fullMelt = weight * marketPrice * purity;
    const offer = fullMelt * offerPct;
    const profit = fullMelt - offer;

    // Create a unique buy sheet ID for direct additions (treat as single-item buy sheet)
    const buySheetId = Date.now();
    
    // Create item
    const item = {
        id: Date.now(),
        customer: customer,
        category: category,
        metal: metal,
        karat: karat,
        quantity: quantity,
        weight: weight,
        marketPrice: marketPrice,
        offerPct: offerPct,
        fullMelt: fullMelt,
        offer: offer,
        profit: 0, // Set profit to 0 until item is actually sold
        isNonMetal: false, // Explicitly mark as metal item
        datePurchased: datePurchased,
        buySheetId: buySheetId // Track as a buy sheet (direct addition)
    };

    // Check if we can combine with existing same metal/karat
    const existingItemIndex = event.buyList.findIndex(existing => {
        if (existing.isNonMetal) return false;
        // Normalize karat for comparison
        return existing.metal === item.metal && String(existing.karat) === String(item.karat);
    });
    
        if (existingItemIndex !== -1) {
        // Combine with existing item
        const existingItem = event.buyList[existingItemIndex];
        
        // Store merge history for unmerging
        if (!existingItem.mergeHistory) {
            // First merge - store existing item's original state
            existingItem.mergeHistory = [JSON.parse(JSON.stringify(existingItem))];
        }
        // Store the new item's original state
        const itemCopy = JSON.parse(JSON.stringify(item));
        existingItem.mergeHistory.push(itemCopy);
        
        existingItem.weight += item.weight;
        existingItem.fullMelt += item.fullMelt;
        existingItem.offer += item.offer;
        // Combine quantities
        existingItem.quantity = (existingItem.quantity || 1) + (item.quantity || 1);
        // Don't update profit - keep existing profit (0 if unsold, or actual profit if sold)
        // Update customer if provided
        if (customer) {
            existingItem.customer = existingItem.customer 
                ? `${existingItem.customer}, ${customer}` 
                : customer;
        }
        // Track this buy sheet ID (even if item is combined, we track the source buy sheet)
        if (!existingItem.buySheetIds) {
            existingItem.buySheetIds = [existingItem.buySheetId || existingItem.datePurchased];
        }
        existingItem.buySheetIds.push(buySheetId);
    } else {
        // Add as new item
        event.buyList.push(item);
    }
    
    saveEvent(event);
    renderBuyList();
    recalculatePL();
    updateDashboard();
    closeModals();
    
    // Reset form
    document.getElementById('add-item-form').reset();
    document.getElementById('item-date').value = new Date().toISOString().split('T')[0];
}

// Sales Management
function openAddSaleModal() {
    if (!currentEvent) {
        alert('Please select or create an event first');
        return;
    }
    
    // Populate all items from buy list
    populateAllBuyListItems();
    
    document.getElementById('add-sale-modal').classList.add('active');
    document.getElementById('sale-date').value = new Date().toISOString().split('T')[0];
    
    // Reset form
    document.getElementById('sale-buy-item').value = '';
    document.getElementById('sale-weight').value = '';
    document.getElementById('sale-price').value = '';
    document.getElementById('sale-buyer').value = '';
    document.getElementById('sale-item-details').style.display = 'none';
    document.getElementById('sale-weight-group').style.display = 'none';
}

// Helper function to check if item is unsold
// An item is unsold if it has unsold weight available
// For metal items, we track soldWeight to know how much has been sold
// An item is unsold if soldWeight is 0 or undefined, OR if weight > soldWeight
function isItemUnsold(item) {
    // For metal items, check if there's unsold weight
    if (!item.isNonMetal && item.metal && item.karat && item.metal !== 'N/A' && item.karat !== 'N/A') {
        const soldWeight = item.soldWeight || 0;
        const totalWeight = item.weight || 0;
        // Item is unsold if it has weight available (totalWeight > soldWeight)
        return totalWeight > soldWeight;
    }
    
    // For non-metal items, check profit (profit = 0 means unsold)
    const profit = item.profit;
    if (profit === undefined || profit === null || isNaN(profit)) {
        return true;
    }
    if (typeof profit === 'number') {
        return profit <= 0;
    }
    return true;
}

// Helper function to get available (unsold) weight for a metal item
function getAvailableWeight(item) {
    if (!item.isNonMetal && item.metal && item.karat) {
        const soldWeight = item.soldWeight || 0;
        const totalWeight = item.weight || 0;
        return Math.max(0, totalWeight - soldWeight);
    }
    return 0;
}

// Calculate estimated profit for display (melt - offer)
// This is just for display purposes, not stored in item.profit
function getEstimatedProfit(item) {
    if (item.isNonMetal) {
        return 0; // Non-metal items don't have estimated profit
    }
    return (item.fullMelt || 0) - (item.offer || 0);
}
// Fix existing items in buy list that might not have isNonMetal set correctly
function fixBuyListItemProperties(buyList, event) {
    let needsSave = false;
    buyList.forEach(item => {
        // If item has metal and karat but isNonMetal is not set, it's a metal item
        const hasMetal = item.metal && item.metal !== 'N/A' && item.metal !== '';
        const hasKarat = item.karat && item.karat !== 'N/A' && item.karat !== '';
        
        if (hasMetal && hasKarat && item.isNonMetal === undefined) {
            // Likely a metal item that wasn't properly marked
            item.isNonMetal = false;
            needsSave = true;
        }
        
        // Ensure profit is 0 if undefined/null (for unsold items)
        if (item.profit === undefined || item.profit === null) {
            item.profit = 0;
            needsSave = true;
        }
        
        // Initialize soldWeight for metal items if not set
        if (hasMetal && hasKarat && item.soldWeight === undefined) {
            // If profit > 0, the item was likely sold (at least partially)
            // Without knowing the exact weight sold, we'll assume it was fully sold
            // This is safer than marking it as available when it might have been sold
            // New items added after this fix will track soldWeight properly
            if (item.profit > 0) {
                item.soldWeight = item.weight || 0; // Assume fully sold
            } else {
                item.soldWeight = 0; // Not sold
            }
            needsSave = true;
        }
    });
    
    // Save if we made any changes
    if (needsSave && event) {
        saveEvent(event);
        console.log('Fixed buy list items and saved event');
    }
}

// Populate metal options in the sales modal
function populateMetalOptions() {
    const event = getEvent(currentEvent);
    if (!event) {
        console.error('No event selected');
        return;
    }
    
    const buyList = event.buyList || [];
    
    // Fix any existing items that might have missing properties
    fixBuyListItemProperties(buyList, event);
    
    console.log('Buy List:', buyList);
    console.log('Buy List length:', buyList.length);
    
    // Find unsold metal items
    // Metal items are those that are NOT explicitly marked as non-metal AND have metal/karat properties
    const unsoldMetalItems = buyList.filter(item => {
        // Skip if explicitly non-metal
        if (item.isNonMetal === true) {
            console.log('Skipping non-metal item:', item);
            return false;
        }
        // Must have metal and karat properties to be considered a metal item
        // Check if metal/karat exist and are valid (not 'N/A', not empty, not 0)
        const hasMetal = item.metal && item.metal !== 'N/A' && item.metal !== '';
        const hasKarat = item.karat && item.karat !== 'N/A' && item.karat !== '';
        
        if (!hasMetal || !hasKarat) {
            console.log('Skipping item missing metal/karat:', {
                metal: item.metal,
                karat: item.karat,
                hasMetal,
                hasKarat,
                item
            });
            return false;
        }
        // Must be unsold
        const unsold = isItemUnsold(item);
        if (!unsold) {
            console.log('Skipping sold item (profit > 0):', {
                profit: item.profit,
                item
            });
        }
        return unsold;
    });
    console.log('Unsold metal items:', unsoldMetalItems);
    
    // Group by metal type
    const metalTypes = {};
    unsoldMetalItems.forEach(item => {
        // Normalize karat to string for consistent matching
        const karatStr = String(item.karat);
        const availableWeight = getAvailableWeight(item);
        
        if (!metalTypes[item.metal]) {
            metalTypes[item.metal] = {};
        }
        if (!metalTypes[item.metal][karatStr]) {
            metalTypes[item.metal][karatStr] = {
                totalWeight: 0,
                totalOffer: 0,
                items: []
            };
        }
        const buyListIndex = buyList.findIndex(buyItem => buyItem.id === item.id);
        if (buyListIndex !== -1 && availableWeight > 0) {
            // Only count available (unsold) weight
            metalTypes[item.metal][karatStr].totalWeight += availableWeight;
            // Calculate available offer based on available weight ratio
            const weightRatio = availableWeight / (item.weight || 1);
            metalTypes[item.metal][karatStr].totalOffer += (item.offer || 0) * weightRatio;
            metalTypes[item.metal][karatStr].items.push({ item, index: buyListIndex });
        }
    });
    
    // Populate metal dropdown
    const metalSelect = document.getElementById('sale-metal-select');
    if (!metalSelect) {
        console.error('sale-metal-select element not found');
        return;
    }
    
    metalSelect.innerHTML = '<option value="">-- Select Metal --</option>';
    
    const metalKeys = Object.keys(metalTypes);
    console.log('Metal types found:', metalKeys);
    console.log('Metal types data:', metalTypes);
    
    if (metalKeys.length === 0) {
        console.warn('No metal types found in buy list');
        // Show a message to user
        const option = document.createElement('option');
        option.value = '';
        option.textContent = '-- No unsold metal items in Buy List --';
        option.disabled = true;
        metalSelect.appendChild(option);
    } else {
        metalKeys.sort().forEach(metal => {
            const option = document.createElement('option');
            option.value = metal;
            option.textContent = metal;
            option.dataset.metalData = JSON.stringify(metalTypes[metal]);
            metalSelect.appendChild(option);
        });
    }
    
    // Store metal data globally for karat selection
    window.metalData = metalTypes;
}
// Populate karat options based on selected metal
function populateKaratOptions(selectedMetal) {
    const karatSelect = document.getElementById('sale-karat-select');
    karatSelect.innerHTML = '<option value="">-- Select Karat --</option>';
    
    if (!selectedMetal || !window.metalData || !window.metalData[selectedMetal]) {
        karatSelect.disabled = true;
        document.getElementById('sale-metal-info').style.display = 'none';
        return;
    }
    
    karatSelect.disabled = false;
    const karatGroups = window.metalData[selectedMetal];
    
    // Sort karats (numeric ones first, then others)
    const sortedKarats = Object.keys(karatGroups).sort((a, b) => {
        const aNum = parseInt(a);
        const bNum = parseInt(b);
        if (!isNaN(aNum) && !isNaN(bNum)) {
            return aNum - bNum;
        }
        return a.localeCompare(b);
    });
    
    sortedKarats.forEach(karat => {
        const group = karatGroups[karat];
        const option = document.createElement('option');
        option.value = karat;
        // Format karat label - if it's a number, add K, otherwise use as-is
        const karatNum = parseInt(karat);
        const karatLabel = !isNaN(karatNum) && karatNum <= 24 ? `${karatNum}K` : karat;
        option.textContent = `${karatLabel} (${group.totalWeight.toFixed(2)}g available, Cost: ${formatCurrency(group.totalOffer)})`;
        option.dataset.groupData = JSON.stringify({
            metal: selectedMetal,
            karat: karat,
            totalWeight: group.totalWeight,
            totalOffer: group.totalOffer,
            items: group.items.map(({ index }) => index)
        });
        karatSelect.appendChild(option);
    });
}

// Populate non-metal items dropdown
function populateAllBuyListItems() {
    const event = getEvent(currentEvent);
    if (!event) {
        console.error('No event selected');
        return;
    }
    
    const buyList = event.buyList || [];
    
    // Fix any existing items that might have missing properties
    fixBuyListItemProperties(buyList, event);
    
    const select = document.getElementById('sale-buy-item');
    select.innerHTML = '<option value="">-- Select an item you purchased --</option>';
    
    buyList.forEach((item, index) => {
        // Check if item has unsold quantity
        if (!isItemUnsold(item)) {
            return; // Skip fully sold items
        }
        
        const option = document.createElement('option');
        option.value = `item_${index}`;
        option.dataset.item = JSON.stringify(item);
        option.dataset.itemIndex = index;
        
        // Build label based on item type
        let label = '';
        if (item.isNonMetal) {
            // Non-metal item
            label = `${item.category}${item.description ? ' - ' + item.description : ''} (Cost: ${formatCurrency(item.offer)})`;
        } else {
            // Metal item
            const availableWeight = getAvailableWeight(item);
            label = `${item.category || item.metal} - ${item.metal} ${item.karat}K (${availableWeight.toFixed(2)}g available, Cost: ${formatCurrency(item.offer)})`;
        }
        
        option.textContent = label;
        select.appendChild(option);
    });
    
    if (select.options.length === 1) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'No unsold items available';
        option.disabled = true;
        select.appendChild(option);
    }
}

// Handle metal selection change
function onMetalSelected() {
    const selectedMetal = document.getElementById('sale-metal-select').value;
    populateKaratOptions(selectedMetal);
    document.getElementById('sale-metal-info').style.display = 'none';
    document.getElementById('sale-karat-select').value = '';
}

// Handle karat selection change
function onKaratSelected() {
    const selectedKarat = document.getElementById('sale-karat-select').value;
    const selectedMetal = document.getElementById('sale-metal-select').value;
    
    if (!selectedKarat || !selectedMetal) {
        document.getElementById('sale-metal-info').style.display = 'none';
        return;
    }
    
    // Get group data from selected option
    const karatSelect = document.getElementById('sale-karat-select');
    const selectedOption = karatSelect.options[karatSelect.selectedIndex];
    const groupData = JSON.parse(selectedOption.dataset.groupData);
    
    // Update info display
    document.getElementById('sale-available-weight').textContent = groupData.totalWeight.toFixed(2);
    document.getElementById('sale-available-cost').textContent = formatCurrency(groupData.totalOffer);
    document.getElementById('sale-metal-info').style.display = 'block';
    
    // Store selected value for use in addSale
    document.getElementById('sale-metal-select').dataset.selectedValue = `metal_${selectedMetal}_${selectedKarat}`;
    document.getElementById('sale-metal-select').dataset.groupData = selectedOption.dataset.groupData;
}

// Handle item selection from buy list
function onSaleItemSelected() {
    const select = document.getElementById('sale-buy-item');
    const selectedValue = select.value;
    const detailsDiv = document.getElementById('sale-item-details');
    const weightGroup = document.getElementById('sale-weight-group');
    
    if (!selectedValue || selectedValue === '') {
        detailsDiv.style.display = 'none';
        weightGroup.style.display = 'none';
        return;
    }
    
    const selectedOption = select.options[select.selectedIndex];
    const itemIndex = parseInt(selectedOption.dataset.itemIndex);
    const item = JSON.parse(selectedOption.dataset.item);
    
    // Display item details
    document.getElementById('sale-item-category').textContent = item.category || '-';
    
    if (item.isNonMetal) {
        document.getElementById('sale-item-type-display').textContent = `${item.category}${item.description ? ' - ' + item.description : ''}`;
        document.getElementById('sale-item-cost').textContent = formatCurrency(item.offer);
        document.getElementById('sale-item-available').textContent = '1 item';
        weightGroup.style.display = 'none';
        document.getElementById('sale-weight').required = false;
    } else {
        const availableWeight = getAvailableWeight(item);
        document.getElementById('sale-item-type-display').textContent = `${item.metal} ${item.karat}K`;
        document.getElementById('sale-item-cost').textContent = formatCurrency(item.offer);
        document.getElementById('sale-item-available').textContent = `${availableWeight.toFixed(2)}g available`;
        weightGroup.style.display = 'block';
        document.getElementById('sale-weight').required = true;
        document.getElementById('sale-weight').max = availableWeight;
        document.getElementById('sale-weight').placeholder = `Max: ${availableWeight.toFixed(2)}g`;
    }
    
    detailsDiv.style.display = 'block';
    
    // Store the selected value for use in addSale
    document.getElementById('sale-buy-item').dataset.selectedValue = selectedValue;
    document.getElementById('sale-buy-item').dataset.itemIndex = itemIndex;
}

function toggleSaleFields() {
    const itemType = document.getElementById('sale-item-type').value;
    const metalSelection = document.getElementById('sale-metal-selection');
    const nonMetalSelection = document.getElementById('sale-non-metal-selection');
    
    if (itemType === 'metal') {
        metalSelection.style.display = 'block';
        nonMetalSelection.style.display = 'none';
        
        // Make required fields
        document.getElementById('sale-metal-select').required = true;
        document.getElementById('sale-karat-select').required = true;
        document.getElementById('sale-weight').required = true;
        document.getElementById('sale-price-gram').required = true;
        document.getElementById('sale-buy-item').required = false;
    } else {
        metalSelection.style.display = 'none';
        nonMetalSelection.style.display = 'block';
        
        // Make required fields
        document.getElementById('sale-metal-select').required = false;
        document.getElementById('sale-karat-select').required = false;
        document.getElementById('sale-weight').required = false;
        document.getElementById('sale-price-gram').required = false;
        document.getElementById('sale-buy-item').required = true;
    }
}
function addSale(e) {
    e.preventDefault();
    const event = getEvent(currentEvent);
    event.sales = event.sales || [];
    
    const selectedValue = document.getElementById('sale-buy-item').value;
    const salePrice = parseFloat(document.getElementById('sale-price').value);
    const buyer = document.getElementById('sale-buyer').value || '';
    const date = document.getElementById('sale-date').value;
    
    if (!selectedValue || !selectedValue.startsWith('item_')) {
        alert('Please select an item from the Buy List');
        return;
    }
    
    if (!salePrice || isNaN(salePrice) || salePrice <= 0) {
        alert('Please enter a valid sale price');
        return;
    }

    const buyList = event.buyList || [];
    const buyListIndex = parseInt(selectedValue.split('_')[1]);
    const buyItem = buyList[buyListIndex];
    
    if (!buyItem) {
        alert('Selected item not found. Please refresh and try again.');
        return;
    }

    const sale = {
        id: Date.now(),
        buyer: buyer,
        date: date,
        totalRevenue: salePrice,
        buyListIndex: buyListIndex
    };
    
    if (buyItem.isNonMetal) {
        // Non-metal item - sell entire item
        sale.category = buyItem.category;
        sale.itemType = 'non-metal';
        sale.description = buyItem.description || '';
        sale.purchaseCost = buyItem.offer;
        sale.profit = salePrice - buyItem.offer;
        
        // Update the buy list item's profit automatically
        event.buyList[buyListIndex].profit = sale.profit;
    } else {
        // Metal item - need weight sold
        const weightSold = parseFloat(document.getElementById('sale-weight').value);
        
        if (!weightSold || isNaN(weightSold) || weightSold <= 0) {
            alert('Please enter the weight sold');
            return;
        }
        
        const availableWeight = getAvailableWeight(buyItem);
        if (weightSold > availableWeight) {
            alert(`Not enough unsold weight available. Only ${availableWeight.toFixed(2)}g available.`);
            return;
        }
        
        // Calculate purchase cost based on weight sold
        const costPerGram = buyItem.offer / buyItem.weight;
        const purchaseCost = weightSold * costPerGram;
        
        sale.itemType = 'metal';
        sale.metal = buyItem.metal;
        sale.karat = buyItem.karat;
        sale.category = buyItem.category;
        sale.weightSold = weightSold;
        sale.salePricePerGram = salePrice / weightSold;
        sale.purchaseCost = purchaseCost;
        sale.profit = salePrice - purchaseCost;
        
        // Update the buy list item's profit and sold weight
        const profitForThisSale = salePrice - purchaseCost;
        event.buyList[buyListIndex].profit = (event.buyList[buyListIndex].profit || 0) + profitForThisSale;
        event.buyList[buyListIndex].soldWeight = (event.buyList[buyListIndex].soldWeight || 0) + weightSold;
    }
    event.sales.push(sale);
    saveEvent(event);
    renderBuyList(); // Re-render to show updated profits
    renderSales();
    recalculatePL();
    updateDashboard();
    closeModals();
    
    // Reset form
    document.getElementById('add-sale-form').reset();
    document.getElementById('sale-date').value = new Date().toISOString().split('T')[0];
    document.getElementById('sale-item-details').style.display = 'none';
    document.getElementById('sale-weight-group').style.display = 'none';
}

function calculateNonMetalPurchaseCost(category, description, buyList) {
    // Find matching non-metal items in buy list
    const matchingItems = buyList.filter(item => 
        item.isNonMetal && 
        item.category === category &&
        (description ? item.description === description : true)
    );
    
    if (matchingItems.length === 0) {
        return 0; // No matching purchase found
    }
    
    // Use FIFO - return the cost of the first matching item
    // For simplicity, if there are multiple, we'll use the first one's offer
    return matchingItems[0].offer || 0;
}

function updateBuyListProfitFromSale(sale, buyList) {
    // Update profit on metal items that were sold
    let remainingWeight = sale.weightSold;
    
    for (const item of buyList) {
        if (remainingWeight <= 0) break;
        
        if (!item.isNonMetal && item.metal === sale.metal) {
            // Calculate how much of this item was sold
            const usedWeight = Math.min(remainingWeight, item.weight);
            const weightRatio = usedWeight / item.weight;
            
            // Calculate profit for this portion
            const saleRevenue = usedWeight * sale.salePricePerGram;
            const purchaseCost = item.offer * weightRatio;
            const profitForThisItem = saleRevenue - purchaseCost;
            
            // Update the item's profit (add to existing profit if any)
            item.profit = (item.profit || 0) + profitForThisItem;
            
            remainingWeight -= usedWeight;
        }
    }
}
function updateBuyListProfitFromNonMetalSale(sale, buyList) {
    // Find matching non-metal items in buy list and update their profit
    const matchingItems = buyList.filter(item => 
        item.isNonMetal && 
        item.category === sale.category &&
        (sale.description ? item.description === sale.description : true)
    );
    
    if (matchingItems.length === 0) {
        return; // No matching purchase found
    }
    
    // Update profit on the first matching item (FIFO)
    const item = matchingItems[0];
    // Calculate profit: Sale Price - Purchase Offer
    item.profit = sale.totalRevenue - item.offer;
}
function renderSales() {
    if (!currentEvent) {
        document.getElementById('sales-tbody').innerHTML = '<tr><td colspan="10" class="empty-message">Please select an event first.</td></tr>';
        document.getElementById('sales-totals').style.display = 'none';
        return;
    }

    const event = getEvent(currentEvent);
    const sales = event.sales || [];

    if (sales.length === 0) {
        document.getElementById('sales-tbody').innerHTML = '<tr><td colspan="10" class="empty-message">No sales recorded yet.</td></tr>';
        document.getElementById('sales-totals').style.display = 'none';
        return;
    }

    const tbody = document.getElementById('sales-tbody');
    tbody.innerHTML = sales.map((sale, index) => {
        const profitClass = sale.profit >= 0 ? 'profit-positive' : 'profit-negative';
        if (sale.itemType === 'metal') {
            return `
                <tr class="sales-row">
                    <td class="sales-date">${sale.date || '-'}</td>
                    <td class="sales-category">${sale.category || '-'}</td>
                    <td class="sales-description">
                        <div class="sales-metal-type">${sale.metal || '-'}</div>
                        ${sale.karat ? `<div class="sales-karat">${sale.karat}</div>` : ''}
                    </td>
                    <td class="sales-weight">${sale.weightSold ? sale.weightSold.toFixed(2) : '-'}</td>
                    <td class="sales-price">${sale.salePricePerGram ? formatCurrency(sale.salePricePerGram) : '-'}</td>
                    <td class="sales-revenue">${formatCurrency(sale.totalRevenue || 0)}</td>
                    <td class="sales-cost">${formatCurrency(sale.purchaseCost || 0)}</td>
                    <td class="sales-profit ${profitClass}">${formatCurrency(sale.profit || 0)}</td>
                    <td class="sales-buyer">${sale.buyer || '-'}</td>
                    <td class="sales-actions">
                        <button class="btn-icon" onclick="editSale(${index})" title="Edit">✏️</button>
                        <button class="btn-icon btn-danger" onclick="deleteSale(${index})" title="Delete">🗑️</button>
                    </td>
                </tr>
            `;
        } else {
            return `
                <tr class="sales-row">
                    <td class="sales-date">${sale.date || '-'}</td>
                    <td class="sales-category">${sale.category || '-'}</td>
                    <td class="sales-description">
                        <div class="sales-item-desc">${sale.description || '-'}</div>
                    </td>
                    <td class="sales-weight">-</td>
                    <td class="sales-price">-</td>
                    <td class="sales-revenue">${formatCurrency(sale.totalRevenue || 0)}</td>
                    <td class="sales-cost">${formatCurrency(sale.purchaseCost || 0)}</td>
                    <td class="sales-profit ${profitClass}">${formatCurrency(sale.profit || 0)}</td>
                    <td class="sales-buyer">${sale.buyer || '-'}</td>
                    <td class="sales-actions">
                        <button class="btn-icon" onclick="editSale(${index})" title="Edit">✏️</button>
                        <button class="btn-icon btn-danger" onclick="deleteSale(${index})" title="Delete">🗑️</button>
                    </td>
                </tr>
            `;
        }
    }).join('');
    
    // Update sales totals
    updateSalesTotals(sales);
}

function updateSalesTotals(sales) {
    const totalCount = sales.length;
    const totalRevenue = sales.reduce((sum, sale) => sum + (sale.totalRevenue || 0), 0);
    const totalCost = sales.reduce((sum, sale) => sum + (sale.purchaseCost || 0), 0);
    const totalProfit = totalRevenue - totalCost;
    
    document.getElementById('sales-total-count').textContent = totalCount;
    document.getElementById('sales-total-revenue').textContent = formatCurrency(totalRevenue);
    document.getElementById('sales-total-cost').textContent = formatCurrency(totalCost);
    document.getElementById('sales-total-profit').textContent = formatCurrency(totalProfit);
    
    if (totalCount > 0) {
        document.getElementById('sales-totals').style.display = 'block';
    } else {
        document.getElementById('sales-totals').style.display = 'none';
    }
}

function calculatePurchaseCost(metal, weightSold, buyList) {
    // Simple FIFO calculation - match weight sold to purchase costs
    let remainingWeight = weightSold;
    let totalCost = 0;

    for (const item of buyList) {
        if (item.metal === metal && remainingWeight > 0) {
            const usedWeight = Math.min(remainingWeight, item.weight);
            const costPerGram = item.offer / item.weight;
            totalCost += usedWeight * costPerGram;
            remainingWeight -= usedWeight;
        }
    }

    return totalCost;
}
function editSale(index) {
    const event = getEvent(currentEvent);
    const sale = event.sales[index];
    
    // Store old values to recalculate buy list profits
    const oldSale = { ...sale };
    
    if (sale.itemType === 'metal') {
        const newWeight = prompt('Enter new weight sold (grams):', sale.weightSold);
        const newPrice = prompt('Enter new sale price per gram:', sale.salePricePerGram);
        
        if (newWeight !== null && newPrice !== null && !isNaN(newWeight) && !isNaN(newPrice)) {
            sale.weightSold = parseFloat(newWeight);
            sale.salePricePerGram = parseFloat(newPrice);
            sale.totalRevenue = sale.weightSold * sale.salePricePerGram;
            sale.purchaseCost = calculatePurchaseCost(sale.metal, sale.weightSold, event.buyList || []);
            sale.profit = sale.totalRevenue - sale.purchaseCost;
            
            // Recalculate buy list profits
            updateBuyListProfitFromSale(sale, event.buyList || []);
            
            saveEvent(event);
            renderBuyList(); // Re-render to show updated profits
            renderSales();
            recalculatePL();
        }
    } else {
        const newPrice = prompt('Enter new total sale price:', sale.totalRevenue);
        
        if (newPrice !== null && !isNaN(newPrice)) {
            sale.totalRevenue = parseFloat(newPrice);
            sale.purchaseCost = calculateNonMetalPurchaseCost(sale.category, sale.description, event.buyList || []);
            sale.profit = sale.totalRevenue - sale.purchaseCost;
            
            // Recalculate buy list profits
            updateBuyListProfitFromNonMetalSale(sale, event.buyList || []);
            
            saveEvent(event);
            renderBuyList(); // Re-render to show updated profits
            renderSales();
            recalculatePL();
        }
    }
}

function deleteSale(index) {
    if (confirm('Are you sure you want to delete this sale? This will reset the profit on the related items.')) {
        const event = getEvent(currentEvent);
        const sale = event.sales[index];
        
        // Reset profit on related buy list items
        if (sale.itemType === 'metal') {
            // For metal items, we'd need to recalculate all profits from remaining sales
            // For simplicity, we'll just note that profits should be recalculated
            // In a full implementation, you'd recalculate all sales
        } else {
            // Reset profit on matching non-metal items
            const matchingItems = event.buyList.filter(item => 
                item.isNonMetal && 
                item.category === sale.category &&
                (sale.description ? item.description === sale.description : true)
            );
            
            matchingItems.forEach(item => {
                // Reset profit to 0 (no sale yet)
                item.profit = 0;
            });
        }
        
        event.sales.splice(index, 1);
        saveEvent(event);
        renderBuyList(); // Re-render to show updated profits
        renderSales();
        recalculatePL();
    }
}

// Expenses Management
function openAddExpenseModal() {
    if (!currentEvent) {
        alert('Please select or create an event first');
        return;
    }
    document.getElementById('add-expense-modal').classList.add('active');
    document.getElementById('expense-date').value = new Date().toISOString().split('T')[0];
}

function addExpense(e) {
    e.preventDefault();
    const event = getEvent(currentEvent);
    event.expenses = event.expenses || [];

    const expense = {
        id: Date.now(),
        category: document.getElementById('expense-category').value,
        description: document.getElementById('expense-description').value,
        amount: parseFloat(document.getElementById('expense-amount').value),
        date: document.getElementById('expense-date').value
    };

    event.expenses.push(expense);
    saveEvent(event);
    renderExpenses();
    recalculatePL();
    closeModals();
}

function renderExpenses() {
    if (!currentEvent) {
        document.getElementById('expenses-tbody').innerHTML = '<tr><td colspan="5" class="empty-message">Please select an event first.</td></tr>';
        return;
    }

    const event = getEvent(currentEvent);
    const expenses = event.expenses || [];

    if (expenses.length === 0) {
        document.getElementById('expenses-tbody').innerHTML = '<tr><td colspan="5" class="empty-message">No expenses recorded yet.</td></tr>';
        return;
    }

    const tbody = document.getElementById('expenses-tbody');
    tbody.innerHTML = expenses.map((expense, index) => `
        <tr>
            <td>${expense.category}</td>
            <td>${expense.description}</td>
            <td>${formatCurrency(expense.amount)}</td>
            <td>${expense.date}</td>
            <td>
                <button class="btn-secondary" onclick="editExpense(${index})">Edit</button>
                <button class="btn-secondary" onclick="deleteExpense(${index})">Delete</button>
            </td>
        </tr>
    `).join('');
}

function editExpense(index) {
    const event = getEvent(currentEvent);
    const expense = event.expenses[index];
    
    const newAmount = prompt('Enter new amount:', expense.amount);
    if (newAmount !== null && !isNaN(newAmount)) {
        expense.amount = parseFloat(newAmount);
        saveEvent(event);
        renderExpenses();
        recalculatePL();
    }
}

function deleteExpense(index) {
    if (confirm('Are you sure you want to delete this expense?')) {
        const event = getEvent(currentEvent);
        event.expenses.splice(index, 1);
        saveEvent(event);
        renderExpenses();
        recalculatePL();
    }
}
// P/L Calculations
function recalculatePL() {
    console.log('🔍 recalculatePL called, currentEvent:', currentEvent);
    
    const reportsEmptyMsg = document.getElementById('reports-empty-message');
    const reportsContent = document.getElementById('reports-content');
    const reportsTab = document.getElementById('reports');
    
    // Check if Reports tab is currently active - only update display if it is
    const isReportsTabActive = reportsTab && reportsTab.classList.contains('active') && reportsTab.style.display !== 'none';
    
    // If Reports tab is not active, just update the values silently (don't change visibility)
    if (!isReportsTabActive) {
        console.log('📋 Reports tab not active - updating values only');
        // Still calculate and update values, but don't change tab visibility
    } else {
        // Reports tab is active - manage visibility
        if (reportsContent) {
            reportsContent.style.display = 'block';
            reportsContent.style.visibility = 'visible';
            reportsContent.style.opacity = '1';
        }
        if (reportsEmptyMsg) {
            reportsEmptyMsg.style.display = 'none';
        }
    }
    
    // Check if event is selected
    if (!currentEvent) {
        console.log('⚠️ No event selected - showing $0.00 values');
        // Update values to $0.00
        const plTotalOfferEl = document.getElementById('pl-total-offer');
        const plTotalRevenueEl = document.getElementById('pl-total-revenue');
        const plSummaryExpensesEl = document.getElementById('pl-summary-expenses');
        const plNetProfitEl = document.getElementById('pl-net-profit');
        
        if (plTotalOfferEl) plTotalOfferEl.textContent = formatCurrency(0);
        if (plTotalRevenueEl) plTotalRevenueEl.textContent = formatCurrency(0);
        if (plSummaryExpensesEl) plSummaryExpensesEl.textContent = formatCurrency(0);
        if (plNetProfitEl) plNetProfitEl.textContent = formatCurrency(0);
        
        // Only manage visibility if Reports tab is active
        if (isReportsTabActive) {
            if (reportsEmptyMsg) {
                reportsEmptyMsg.style.display = 'block';
            }
            if (reportsContent) {
                reportsContent.style.display = 'none';
            }
        }
        return;
    }
    // Get event data
    const event = getEvent(currentEvent);
    if (!event) {
        console.error('❌ Event not found:', currentEvent);
        // Only manage visibility if Reports tab is active
        if (isReportsTabActive) {
            if (reportsEmptyMsg) {
                reportsEmptyMsg.style.display = 'block';
            }
            if (reportsContent) {
                reportsContent.style.display = 'none';
            }
        }
        // Still set values to $0.00
        const plTotalOfferEl = document.getElementById('pl-total-offer');
        const plTotalRevenueEl = document.getElementById('pl-total-revenue');
        const plSummaryExpensesEl = document.getElementById('pl-summary-expenses');
        const plNetProfitEl = document.getElementById('pl-net-profit');
        
        if (plTotalOfferEl) plTotalOfferEl.textContent = formatCurrency(0);
        if (plTotalRevenueEl) plTotalRevenueEl.textContent = formatCurrency(0);
        if (plSummaryExpensesEl) plSummaryExpensesEl.textContent = formatCurrency(0);
        if (plNetProfitEl) plNetProfitEl.textContent = formatCurrency(0);
        return;
    }

    console.log('✅ Event found:', event.name, {
        buyListCount: (event.buyList || []).length,
        salesCount: (event.sales || []).length,
        expensesCount: (event.expenses || []).length
    });
    // Only manage visibility if Reports tab is active
    if (isReportsTabActive) {
        // Show content, hide empty message
        if (reportsEmptyMsg) {
            reportsEmptyMsg.style.display = 'none';
        }
        if (reportsContent) {
            reportsContent.style.display = 'block';
            reportsContent.style.visibility = 'visible';
            reportsContent.style.opacity = '1';
        }
    }

    // Get data arrays
    const buyList = event.buyList || [];
    const sales = event.sales || [];
    const expenses = event.expenses || [];

    // Calculate totals
    const totalOffer = buyList.reduce((sum, item) => sum + (parseFloat(item.offer) || 0), 0);
    const totalRevenue = sales.reduce((sum, sale) => sum + (parseFloat(sale.totalRevenue || sale.totalPrice) || 0), 0);
    
    // Calculate purchase cost of items actually sold
    let totalPurchaseCost = 0;
    sales.forEach(sale => {
        if (sale.purchaseCost !== undefined && sale.purchaseCost !== null) {
            totalPurchaseCost += parseFloat(sale.purchaseCost) || 0;
        } else if (sale.buyListIndex !== undefined && buyList[sale.buyListIndex]) {
            const buyItem = buyList[sale.buyListIndex];
                if (buyItem.isNonMetal) {
                totalPurchaseCost += parseFloat(buyItem.offer) || 0;
                } else {
                const weightSold = parseFloat(sale.weightSold || buyItem.weight) || 0;
                const itemOffer = parseFloat(buyItem.offer) || 0;
                const itemWeight = parseFloat(buyItem.weight) || 1;
                if (itemWeight > 0) {
                    totalPurchaseCost += (weightSold * itemOffer) / itemWeight;
                }
            }
        }
    });
    
    const totalExpenses = expenses.reduce((sum, exp) => sum + (parseFloat(exp.amount) || 0), 0);
    const netProfit = totalRevenue - totalPurchaseCost - totalExpenses;

    console.log('💰 Calculated values:', {
        totalOffer,
        totalRevenue,
        totalPurchaseCost,
        totalExpenses,
        netProfit
    });

    // Update display elements
    const plTotalOfferEl = document.getElementById('pl-total-offer');
    const plTotalRevenueEl = document.getElementById('pl-total-revenue');
    const plSummaryExpensesEl = document.getElementById('pl-summary-expenses');
    const plNetProfitEl = document.getElementById('pl-net-profit');
    
    console.log('🎯 P/L elements found:', {
        plTotalOfferEl: !!plTotalOfferEl,
        plTotalRevenueEl: !!plTotalRevenueEl,
        plSummaryExpensesEl: !!plSummaryExpensesEl,
        plNetProfitEl: !!plNetProfitEl
    });
    
    if (plTotalOfferEl) {
        plTotalOfferEl.textContent = formatCurrency(totalOffer);
        console.log('✅ Updated pl-total-offer:', formatCurrency(totalOffer));
    } else {
        console.error('❌ pl-total-offer element NOT FOUND!');
    }
    
    if (plTotalRevenueEl) {
        plTotalRevenueEl.textContent = formatCurrency(totalRevenue);
        console.log('✅ Updated pl-total-revenue:', formatCurrency(totalRevenue));
    } else {
        console.error('❌ pl-total-revenue element NOT FOUND!');
    }
    
    if (plSummaryExpensesEl) {
        plSummaryExpensesEl.textContent = formatCurrency(totalExpenses);
        console.log('✅ Updated pl-summary-expenses:', formatCurrency(totalExpenses));
    } else {
        console.error('❌ pl-summary-expenses element NOT FOUND!');
    }
    
    if (plNetProfitEl) {
        plNetProfitEl.textContent = formatCurrency(netProfit);
        console.log('✅ Updated pl-net-profit:', formatCurrency(netProfit));
    } else {
        console.error('❌ pl-net-profit element NOT FOUND!');
    }
    
    // Force a repaint
    if (reportsContent) {
        reportsContent.offsetHeight; // Force reflow
    }
}

// Dashboard
function updateDashboard() {
    // Update welcome message with user's name
    updateWelcomeMessage();
    
    if (!currentEvent) {
        resetDashboard();
        // Still update overview even when no event is selected (it shows all events)
        updateDashboardOverview(null, [], []);
        return;
    }

    const event = getEvent(currentEvent);
    const buyList = event.buyList || [];
    const sales = event.sales || [];
    const expenses = event.expenses || [];

    // Get filter
    const activeFilter = document.querySelector('.filter-btn.active')?.dataset.filter || 'all';
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Filter data
    let filteredBuyList = buyList;
    let filteredSales = sales;
    let filteredExpenses = expenses;

    if (activeFilter === 'today') {
        filteredBuyList = buyList.filter(item => item.datePurchased === today);
        filteredSales = sales.filter(sale => sale.date === today);
        filteredExpenses = expenses.filter(exp => exp.date === today);
    } else if (activeFilter === 'week') {
        filteredBuyList = buyList.filter(item => item.datePurchased >= weekAgo);
        filteredSales = sales.filter(sale => sale.date >= weekAgo);
        filteredExpenses = expenses.filter(exp => exp.date >= weekAgo);
    }

    // Calculate stats
    const uniqueCustomers = new Set(filteredBuyList.map(item => item.customer).filter(c => c)).size;
    const totalItems = filteredBuyList.length;
    const totalMelt = filteredBuyList.reduce((sum, item) => sum + item.fullMelt, 0);
    const totalOffer = filteredBuyList.reduce((sum, item) => sum + item.offer, 0);

    // Update display
    document.getElementById('stat-customers').textContent = uniqueCustomers;
    document.getElementById('stat-items').textContent = totalItems;
    document.getElementById('stat-melt').textContent = formatCurrency(totalMelt);
    document.getElementById('stat-offer').textContent = formatCurrency(totalOffer);
    
    // Update Overview section (always shows all events combined)
    updateDashboardOverview(event, filteredSales, filteredExpenses);
}

// Get user profile from database
async function getUserProfile() {
    if (!currentUser || !USE_SUPABASE || !supabase) return null;
    
    try {
        const userId = getUserId();
        const { data, error } = await supabase
            .from('user_profiles')
            .select('*')
            .eq('user_id', userId)
            .single();
        
        if (error) {
            const isNotFound = error.code === 'PGRST116';
            const isMissingTable = error.code === '42P01';
            const isAccessDenied = error.status === 406 || (error.message && /Could not fetch properties/i.test(error.message));

            if (isNotFound || isMissingTable || isAccessDenied) {
                console.warn('User profile unavailable:', {
                    code: error.code,
                    status: error.status,
                    message: error.message
                });
                return null;
            }

            console.error('Error fetching user profile:', error);
            return null;
        }
        
        return data;
    } catch (error) {
        console.error('Error getting user profile:', error);
        return null;
    }
}

// Update welcome message with user's name
async function updateWelcomeMessage() {
    if (!currentUser) return;
    
    const welcomeMessage = document.getElementById('welcome-message');
    const welcomeSubtitle = document.getElementById('welcome-subtitle');
    const welcomeAvatar = document.getElementById('welcome-avatar-img');
    const welcomeAvatarPlaceholder = document.getElementById('welcome-avatar-placeholder');
    
    if (!welcomeMessage) return;
    
    // Get user's name from metadata or profile
    let userName = 'there';
    let fullName = '';
    
    // Try to get name from profile first
    try {
        const profile = await getUserProfile();
        if (profile && profile.full_name) {
            fullName = profile.full_name;
            userName = fullName.split(' ')[0]; // First name only
        }
    } catch (error) {
        console.error('Error loading profile for welcome:', error);
    }
    
    // Fallback to user metadata if profile doesn't have name
    if (!userName || userName === 'there') {
        if (currentUser.user_metadata && currentUser.user_metadata.full_name) {
            fullName = currentUser.user_metadata.full_name;
            userName = fullName.split(' ')[0]; // First name only
        } else if (currentUser.email) {
            // Fallback to email username if no name
            userName = currentUser.email.split('@')[0];
        }
    }
    
    // Update welcome message
    welcomeMessage.textContent = `Welcome Back, ${userName}!`;
    
    // Update subtitle (remove "Loading..." and set proper text)
    if (welcomeSubtitle) {
        welcomeSubtitle.textContent = "Here's your event overview";
    }
    // Update avatar if profile picture exists
    try {
        const profile = await getUserProfile();
        if (profile && profile.profile_picture_url) {
            if (welcomeAvatar) {
                // Add cache busting to ensure fresh image
                const imageUrl = profile.profile_picture_url + (profile.profile_picture_url.includes('?') ? '&' : '?') + 't=' + Date.now();
                welcomeAvatar.src = imageUrl;
                welcomeAvatar.onload = function() {
                    welcomeAvatar.style.display = 'block';
                    if (welcomeAvatarPlaceholder) {
                        welcomeAvatarPlaceholder.style.display = 'none';
                    }
                };
                welcomeAvatar.onerror = function() {
                    console.error('Error loading welcome avatar');
                    // Fall back to placeholder if image fails to load
                    welcomeAvatar.style.display = 'none';
                    if (welcomeAvatarPlaceholder) {
                        welcomeAvatarPlaceholder.style.display = 'flex';
                    }
                };
            }
        } else {
            // Show initials in placeholder
            if (welcomeAvatarPlaceholder) {
                const initials = fullName 
                    ? fullName.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase()
                    : userName.substring(0, 2).toUpperCase();
                welcomeAvatarPlaceholder.textContent = initials;
                welcomeAvatarPlaceholder.style.display = 'flex';
                if (welcomeAvatar) {
                    welcomeAvatar.style.display = 'none';
                }
            }
        }
    } catch (error) {
        console.error('Error loading profile picture:', error);
        // Show initials as fallback
        if (welcomeAvatarPlaceholder) {
            const initials = fullName 
                ? fullName.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase()
                : userName.substring(0, 2).toUpperCase();
            welcomeAvatarPlaceholder.textContent = initials;
            welcomeAvatarPlaceholder.style.display = 'flex';
        }
    }
}

function resetDashboard() {
    document.getElementById('stat-customers').textContent = '0';
    document.getElementById('stat-items').textContent = '0';
    document.getElementById('stat-melt').textContent = '$0.00';
    document.getElementById('stat-offer').textContent = '$0.00';
    
    // Reset overview
    document.getElementById('overview-monthly-profit').textContent = '$0.00';
    document.getElementById('overview-monthly-profit-count').textContent = '0 sales';
    document.getElementById('overview-buy-sheets').textContent = '0';
    document.getElementById('overview-confirmed-sheets').textContent = '0 confirmed';
    document.getElementById('overview-total-sales').textContent = '0';
    document.getElementById('overview-sales-revenue').textContent = '$0.00 revenue';
    document.getElementById('overview-total-expenses').textContent = '0';
    document.getElementById('overview-expenses-amount').textContent = '$0.00 spent';
    document.getElementById('best-sellers-list').innerHTML = '<div class="empty-message">No sales yet</div>';
}
function updateDashboardOverview(event, sales, expenses) {
    // Get all events from localStorage (always show combined data from all events)
    const allEvents = JSON.parse(localStorage.getItem('events') || '[]');
    
    // If no events exist, show empty state
    if (allEvents.length === 0) {
        document.getElementById('overview-monthly-profit').textContent = '$0.00';
        document.getElementById('overview-monthly-profit-count').textContent = '0 sales';
        document.getElementById('overview-buy-sheets').textContent = '0';
        document.getElementById('overview-confirmed-sheets').textContent = '0 confirmed';
        document.getElementById('overview-total-sales').textContent = '0';
        document.getElementById('overview-sales-revenue').textContent = '$0.00 revenue';
        document.getElementById('overview-total-expenses').textContent = '0';
        document.getElementById('overview-expenses-amount').textContent = '$0.00 spent';
        document.getElementById('best-sellers-list').innerHTML = '<div class="empty-message">No sales yet</div>';
        return;
    }
    
    // Combine data from all events
    let allSales = [];
    let allExpenses = [];
    let allBuyLists = [];
    const allUniqueTransactions = new Set();
    
    allEvents.forEach(evt => {
        // Combine all sales
        if (evt.sales && Array.isArray(evt.sales)) {
            allSales = allSales.concat(evt.sales);
        }
        
        // Combine all expenses
        if (evt.expenses && Array.isArray(evt.expenses)) {
            allExpenses = allExpenses.concat(evt.expenses);
        }
        
        // Combine all buy lists
        if (evt.buyList && Array.isArray(evt.buyList)) {
            allBuyLists = allBuyLists.concat(evt.buyList);
        }
    });
    // Calculate monthly profit (this month) - across all events
    const now = new Date();
    const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    const monthlySales = allSales.filter(sale => sale.date >= firstDayOfMonth);
    const monthlyExpenses = allExpenses.filter(exp => exp.date >= firstDayOfMonth);
    const monthlyRevenue = monthlySales.reduce((sum, sale) => sum + (sale.totalRevenue || 0), 0);
    const monthlyPurchaseCost = monthlySales.reduce((sum, sale) => sum + (sale.purchaseCost || 0), 0);
    const monthlyExpensesAmount = monthlyExpenses.reduce((sum, exp) => sum + (exp.amount || 0), 0);
    const monthlyProfit = monthlyRevenue - monthlyPurchaseCost - monthlyExpensesAmount;
    
    // Count buy sheets (confirmed transactions) - across all events
    // Use buySheetId to track unique buy sheet confirmations
    // When items are combined, they might have buySheetIds array or single buySheetId
    const buySheetIds = new Set();
    allBuyLists.forEach(item => {
        // Check if item has buySheetId (single buy sheet)
        if (item.buySheetId) {
            buySheetIds.add(item.buySheetId);
        }
        // Check if item has buySheetIds array (multiple buy sheets combined)
        if (item.buySheetIds && Array.isArray(item.buySheetIds)) {
            item.buySheetIds.forEach(id => {
                buySheetIds.add(id);
            });
        }
        // For items without buySheetId but with datePurchased (legacy items)
        // Count by datePurchased + customer as fallback
        if (!item.buySheetId && !item.buySheetIds && item.datePurchased) {
            const customer = item.customer || '';
            const fallbackKey = customer ? `${item.datePurchased}_${customer}` : item.datePurchased;
            buySheetIds.add(`legacy_${fallbackKey}`);
        }
    });
    
    const totalBuySheets = buySheetIds.size;
    const confirmedBuySheets = totalBuySheets; // All items with buySheetId or datePurchased are from confirmed buy sheets
    
    // Calculate total sales and revenue - across all events
    const totalSalesCount = allSales.length;
    const totalSalesRevenue = allSales.reduce((sum, sale) => sum + (sale.totalRevenue || 0), 0);
    
    // Calculate total expenses - across all events
    const totalExpensesCount = allExpenses.length;
    const totalExpensesAmount = allExpenses.reduce((sum, exp) => sum + (exp.amount || 0), 0);
    
    // Calculate best-selling categories - across all events
    const categorySales = {};
    allSales.forEach(sale => {
        let category = 'Other';
        if (sale.category) {
            category = sale.category;
        } else if (sale.itemType === 'metal' && sale.metal && sale.karat) {
            category = `${sale.metal} ${sale.karat}K`;
        } else if (sale.itemType === 'non-metal' && sale.description) {
            category = sale.description;
        }
        
        if (!categorySales[category]) {
            categorySales[category] = {
                count: 0,
                revenue: 0,
                profit: 0
            };
        }
        categorySales[category].count += 1;
        categorySales[category].revenue += (sale.totalRevenue || 0);
        categorySales[category].profit += (sale.profit || 0);
    });
    
    // Sort by revenue (descending)
    const bestSellers = Object.entries(categorySales)
        .map(([category, data]) => ({ category, ...data }))
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 5); // Top 5
    
    // Update overview display
    document.getElementById('overview-monthly-profit').textContent = formatCurrency(monthlyProfit);
    document.getElementById('overview-monthly-profit-count').textContent = `${monthlySales.length} sale${monthlySales.length !== 1 ? 's' : ''}`;
    document.getElementById('overview-buy-sheets').textContent = totalBuySheets;
    document.getElementById('overview-confirmed-sheets').textContent = `${confirmedBuySheets} confirmed`;
    document.getElementById('overview-total-sales').textContent = totalSalesCount;
    document.getElementById('overview-sales-revenue').textContent = formatCurrency(totalSalesRevenue);
    document.getElementById('overview-total-expenses').textContent = totalExpensesCount;
    document.getElementById('overview-expenses-amount').textContent = formatCurrency(totalExpensesAmount);
    
    // Update best sellers list
    const bestSellersList = document.getElementById('best-sellers-list');
    if (bestSellers.length === 0) {
        bestSellersList.innerHTML = '<div class="empty-message">No sales yet</div>';
    } else {
        bestSellersList.innerHTML = bestSellers.map((seller, index) => `
            <div class="best-seller-item">
                <div class="best-seller-rank">${index + 1}</div>
                <div class="best-seller-info">
                    <div class="best-seller-category">${seller.category}</div>
                    <div class="best-seller-stats">
                        <span>${seller.count} sale${seller.count !== 1 ? 's' : ''}</span>
                        <span>•</span>
                        <span>${formatCurrency(seller.revenue)} revenue</span>
                        <span>•</span>
                        <span>${formatCurrency(seller.profit)} profit</span>
                    </div>
                </div>
            </div>
        `).join('');
    }
}

// Customer Management & Loyalty Tracking & CRM
// Customer CRM data storage
function getCustomersData() {
    return JSON.parse(localStorage.getItem('customersData') || '{}');
}

function saveCustomersData(data) {
    localStorage.setItem('customersData', JSON.stringify(data));
}

function getDeletedCustomers() {
    return JSON.parse(localStorage.getItem('deletedCustomers') || '[]');
}

function saveDeletedCustomers(customers) {
    localStorage.setItem('deletedCustomers', JSON.stringify(customers));
}

function addDeletedCustomer(customerName) {
    const deleted = getDeletedCustomers();
    if (!deleted.includes(customerName)) {
        deleted.push(customerName);
        saveDeletedCustomers(deleted);
    }
}

function getCustomerInfo(customerName) {
    const customers = getCustomersData();
    return customers[customerName] || null;
}

async function saveCustomerInfo(customerName, info) {
    // Validate customer name
    if (!customerName || !customerName.trim()) {
        console.error('Cannot save customer: name is empty');
        return;
    }
    
    customerName = customerName.trim();
    console.log('Saving customer info:', customerName, info);
    
    const customers = getCustomersData();
    if (!customers[customerName]) {
        customers[customerName] = {};
    }
    // Merge new info with existing (only update if new info is provided)
    Object.keys(info).forEach(key => {
        if (info[key] !== undefined && info[key] !== null) {
            // Allow empty strings to clear fields, but only save non-empty values
            const value = info[key] ? info[key].trim() : null;
            if (value) {
                customers[customerName][key] = value;
            }
        }
    });
    saveCustomersData(customers);
    customersCache = { ...customersCache, ...customers };
    console.log('Customer saved to localStorage:', customers[customerName]);
    
    // Also save to database - ensure it syncs immediately
    try {
        const customerData = {
            name: customerName,
            phone: customers[customerName].phone || null,
            email: customers[customerName].email || null,
            address: customers[customerName].address || null,
            city: customers[customerName].city || null,
            state: customers[customerName].state || null,
            zip: customers[customerName].zip || null,
            notes: customers[customerName].notes || null
        };
        
        // Always try to sync immediately (online or queue if offline)
        await executeOrQueue({
            type: 'saveCustomer',
            data: customerData
        });
        console.log('✅ Customer synced to database:', customerData);
    } catch (error) {
        console.error('❌ Error saving customer to database:', error);
        // Continue anyway - data is saved to localStorage and will sync later
    }
    
    refreshCRMIfActive(customerName);
}
function deleteCustomer(customerName) {
    console.log('deleteCustomer called with:', customerName);
    
    if (!customerName) {
        alert('Invalid customer name');
        return false;
    }
    
    // Trim and normalize the customer name
    customerName = String(customerName).trim();
    
    if (!customerName) {
        alert('Invalid customer name');
        return false;
    }
    
    if (!confirm(`Are you sure you want to delete customer "${customerName}"?\n\nThis will remove all their CRM data, but their transaction history will remain in the buy lists.\n\nThis action cannot be undone.`)) {
        return false;
    }
    
    try {
        // Remove from CRM data
        const customers = getCustomersData();
        console.log('Customers data:', customers);
        
        if (!customers || typeof customers !== 'object') {
            alert('Error: Customer data not found');
            return false;
        }
        
        // Check if customer exists (case-insensitive search)
        let foundCustomerName = null;
        for (const key in customers) {
            if (key.toLowerCase() === customerName.toLowerCase()) {
                foundCustomerName = key;
                break;
            }
        }
        
        if (!foundCustomerName) {
            // Try exact match first
            if (customerName in customers) {
                foundCustomerName = customerName;
            } else {
                // Customer might not be in CRM data yet (only exists in buy list)
                // Add them to deleted list to hide them from the customer list
                addDeletedCustomer(customerName);
                renderCustomers();
                alert(`Customer "${customerName}" has been hidden from the customer list. Their transaction history will remain intact.`);
                return true;
            }
        }
        
        // Delete the customer from CRM data (use the found key to handle case differences)
        delete customers[foundCustomerName];
        saveCustomersData(customers);
        
        // Add to deleted list to hide from customer list
        addDeletedCustomer(foundCustomerName);
        
        // Queue backend deletion so Supabase state stays in sync
        executeOrQueue({
            type: 'deleteCustomer',
            data: { name: foundCustomerName }
        }).catch(err => {
            console.error('Error queueing deleteCustomer operation:', err);
        });
        
        // Refresh customer list
        renderCustomers();
        
        alert(`Customer "${foundCustomerName}" has been deleted from CRM data and hidden from the customer list. Their transaction history will remain intact.`);
        return true;
    } catch (error) {
        console.error('Error deleting customer:', error);
        alert(`An error occurred while deleting the customer: ${error.message}`);
        return false;
    }
}

async function clearCRMData() {
    const confirmationMessage = `This will permanently delete all customer CRM records (including contact info, notes, and deleted-customer filters).\n\nBuy sheets and historical transactions will remain, but customers will need to be re-created if you wish to track them again.\n\nAre you sure you want to continue?`;
    if (!confirm(confirmationMessage)) {
        return;
    }

    try {
        // Clear local caches and storage
        saveCustomersData({});
        customersCache = {};

        // Queue or execute Supabase cleanup
        await executeOrQueue({
            type: 'clearCustomers',
            data: {}
        });

        refreshCRMIfActive(null);
        alert('All CRM customer records have been deleted.');
    } catch (error) {
        console.error('Error clearing CRM data:', error);
        alert('Error clearing CRM data: ' + (error.message || 'Unknown error.'));
    }
}

function getAllCustomerNames() {
    // Get customer names from both CRM data and buy list
    const customersData = getCustomersData();
    const allEvents = JSON.parse(localStorage.getItem('events') || '[]');
    const customerNamesSet = new Set();
    
    // Add names from CRM data
    Object.keys(customersData).forEach(name => {
        if (name && !isRefinery(name)) {
            customerNamesSet.add(name);
        }
    });
    
    // Add names from buy lists
    allEvents.forEach(event => {
        const buyList = event.buyList || [];
        buyList.forEach(item => {
            if (item.customer && item.customer.trim()) {
                const names = item.customer.split(',').map(c => c.trim()).filter(c => c);
                names.forEach(name => {
                    if (!isRefinery(name)) {
                        customerNamesSet.add(name);
                    }
                });
            }
        });
    });
    
    return Array.from(customerNamesSet).sort();
}
function showCustomerAutocomplete(query) {
    const dropdown = document.getElementById('customer-autocomplete');
    const queryLower = query.toLowerCase();
    const allCustomers = getAllCustomerNames();
    const customersData = getCustomersData();
    
    // Filter matching customers - exclude refineries
    const matches = allCustomers
        .filter(name => {
            // Skip refineries
            if (isRefinery(name)) {
                return false;
            }
            return name.toLowerCase().includes(queryLower);
        })
        .slice(0, 8); // Limit to 8 suggestions
    
    if (matches.length === 0) {
        hideCustomerAutocomplete();
        return;
    }
    
    // Build dropdown HTML
    dropdown.innerHTML = matches.map(customerName => {
        const customerInfo = customersData[customerName] || {};
        const phone = customerInfo.phone || '';
        const email = customerInfo.email || '';
        
        // Highlight matching text
        const nameParts = customerName.split(new RegExp(`(${query})`, 'gi'));
        const highlightedName = nameParts.map((part, index) => {
            if (part.toLowerCase() === queryLower) {
                return `<span class="autocomplete-item-highlight">${part}</span>`;
            }
            return part;
        }).join('');
        
        let infoText = '';
        if (phone) infoText += `📞 ${phone}`;
        if (email) infoText += infoText ? ` • ✉️ ${email}` : `✉️ ${email}`;
        
        return `
            <div class="autocomplete-item" data-customer-name="${customerName.replace(/"/g, '&quot;')}">
                <div class="autocomplete-item-name">${highlightedName}</div>
                ${infoText ? `<div class="autocomplete-item-info">${infoText}</div>` : ''}
            </div>
        `;
    }).join('');
    
    // Add click handlers
    dropdown.querySelectorAll('.autocomplete-item').forEach(item => {
        item.addEventListener('click', () => {
            const selectedName = item.dataset.customerName;
            selectCustomer(selectedName);
        });
    });
    
    dropdown.style.display = 'block';
}

function showCustomerSearchAutocomplete(query) {
    const dropdown = document.getElementById('customer-search-autocomplete');
    const queryLower = query.toLowerCase();
    const allCustomers = getAllCustomerNames();
    const customersData = getCustomersData();
    
    // Filter matching customers by name or phone
    const matches = allCustomers
        .filter(name => {
            const nameMatch = name.toLowerCase().includes(queryLower);
            const customerInfo = customersData[name] || {};
            const phone = (customerInfo.phone || '').toLowerCase();
            const phoneMatch = phone.includes(queryLower);
            return nameMatch || phoneMatch;
        })
        .slice(0, 8); // Limit to 8 suggestions
    
    if (matches.length === 0) {
        hideCustomerSearchAutocomplete();
        return;
    }
    
    // Build dropdown HTML
    dropdown.innerHTML = matches.map(customerName => {
        const customerInfo = customersData[customerName] || {};
        const phone = customerInfo.phone || '';
        const email = customerInfo.email || '';
        
        // Highlight matching text in name
        const nameParts = customerName.split(new RegExp(`(${query})`, 'gi'));
        const highlightedName = nameParts.map((part, index) => {
            if (part.toLowerCase() === queryLower) {
                return `<span class="autocomplete-item-highlight">${part}</span>`;
            }
            return part;
        }).join('');
        
        // Highlight matching text in phone if query matches phone
        let highlightedPhone = phone;
        if (phone && phone.toLowerCase().includes(queryLower)) {
            const phoneParts = phone.split(new RegExp(`(${query})`, 'gi'));
            highlightedPhone = phoneParts.map((part, index) => {
                if (part.toLowerCase() === queryLower) {
                    return `<span class="autocomplete-item-highlight">${part}</span>`;
                }
                return part;
            }).join('');
        }
        
        let infoText = '';
        if (phone) infoText += `📞 ${highlightedPhone}`;
        if (email) infoText += infoText ? ` • ✉️ ${email}` : `✉️ ${email}`;
        
        return `
            <div class="autocomplete-item" data-customer-name="${customerName.replace(/"/g, '&quot;')}">
                <div class="autocomplete-item-name">${highlightedName}</div>
                ${infoText ? `<div class="autocomplete-item-info">${infoText}</div>` : ''}
            </div>
        `;
    }).join('');
    
    // Add click handlers
    dropdown.querySelectorAll('.autocomplete-item').forEach(item => {
        item.addEventListener('click', () => {
            const selectedName = item.dataset.customerName;
            selectCustomerSearch(selectedName);
        });
    });
    
    dropdown.style.display = 'block';
}

function hideCustomerSearchAutocomplete() {
    const dropdown = document.getElementById('customer-search-autocomplete');
    dropdown.style.display = 'none';
}

function selectCustomerSearch(customerName) {
    const searchInput = document.getElementById('customer-search-input');
    searchInput.value = customerName;
    hideCustomerSearchAutocomplete();
    // Automatically trigger search
    searchCustomers();
}

function hideCustomerAutocomplete() {
    const dropdown = document.getElementById('customer-autocomplete');
    dropdown.style.display = 'none';
}

function selectCustomer(customerName) {
    const customerInput = document.getElementById('buy-sheet-customer');
    customerInput.value = customerName;
    hideCustomerAutocomplete();
    
    // Auto-fill customer info
    const customerInfo = getCustomerInfo(customerName);
    if (customerInfo) {
        fillCustomerInfo(customerInfo);
    }
}

function fillCustomerInfo(customerInfo) {
    document.getElementById('buy-sheet-phone').value = customerInfo.phone || '';
    document.getElementById('buy-sheet-email').value = customerInfo.email || '';
    document.getElementById('buy-sheet-address').value = customerInfo.address || '';
    document.getElementById('buy-sheet-city').value = customerInfo.city || '';
    document.getElementById('buy-sheet-state').value = customerInfo.state || '';
    document.getElementById('buy-sheet-zip').value = customerInfo.zip || '';
}

// Load refinery names from localStorage or use defaults
function getRefineryNames() {
    const saved = localStorage.getItem('refineryNames');
    if (saved) {
        return JSON.parse(saved);
    }
    // Default refineries
    return ['Elemental', 'Elemental Refinery'];
}

function saveRefineryNames(names) {
    localStorage.setItem('refineryNames', JSON.stringify(names));
}

function isRefinery(name) {
    if (!name) return false;
    const normalizedName = name.toLowerCase().trim();
    const refineryNames = getRefineryNames();
    return refineryNames.some(refinery => normalizedName.includes(refinery.toLowerCase()));
}

function openManageRefineriesModal() {
    const modal = document.getElementById('manage-refineries-modal');
    modal.style.display = 'block';
    renderRefineryList();
}

function renderRefineryList() {
    const container = document.getElementById('refinery-list-container');
    const refineries = getRefineryNames();
    
    if (refineries.length === 0) {
        container.innerHTML = '<div class="empty-message">No refineries added yet.</div>';
        return;
    }
    
    container.innerHTML = refineries.map((refinery, index) => `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.75rem; background: #f8f9fa; border-radius: 4px;">
            <span><strong>${refinery}</strong></span>
            <button class="btn-secondary btn-sm" onclick="removeRefinery(${index})" style="background: #dc3545; color: white; border-color: #dc3545;">Remove</button>
        </div>
    `).join('');
}

function addRefinery() {
    const input = document.getElementById('refinery-name-input');
    const name = input.value.trim();
    
    if (!name) {
        alert('Please enter a refinery name');
        return;
    }
    
    const refineries = getRefineryNames();
    if (refineries.includes(name)) {
        alert('This refinery is already in the list');
        return;
    }
    
    refineries.push(name);
    saveRefineryNames(refineries);
    input.value = '';
    renderRefineryList();
    renderCustomers(); // Refresh customer list to exclude new refinery
}

function removeRefinery(index) {
    const refineries = getRefineryNames();
    refineries.splice(index, 1);
    saveRefineryNames(refineries);
    renderRefineryList();
    renderCustomers(); // Refresh customer list to include removed refinery
}
// Global search state
let currentCustomerSearch = null;

async function renderCustomers(searchQuery = null) {
    const tbody = document.getElementById('customers-tbody');
    if (tbody) {
        tbody.innerHTML = '<tr><td colspan="9" class="empty-message">Loading customers...</td></tr>';
    }

    let filteredCustomers = [];
    let renderError = null;

    try {
        console.log('[CRM] renderCustomers start', {
            incomingQuery: searchQuery,
            currentCustomerSearch
        });

        // Allow usage as an event handler (receive Event object)
        if (searchQuery && typeof searchQuery === 'object') {
            if (typeof searchQuery.preventDefault === 'function') {
                searchQuery.preventDefault();
            }
            searchQuery = currentCustomerSearch || null;
        }

        if (!tbody) {
            throw new Error('customers-tbody element not found; cannot render customers');
        }

        // Attempt to refresh from Supabase
        try {
            const latestCustomers = await loadCustomersFromDB();
            const supabaseCount = latestCustomers && typeof latestCustomers === 'object'
                ? Object.keys(latestCustomers).length
                : 0;
            console.log('[CRM] Supabase customers fetched:', supabaseCount);
            if (supabaseCount > 0) {
                customersCache = latestCustomers;
            }
        } catch (supabaseError) {
            console.error('[CRM] Error refreshing customers from Supabase:', supabaseError);
        }

        // Merge cached Supabase data with local storage copy
        let customersData = {};
        try {
            const localCustomersData = getCustomersData() || {};
            customersData = {
                ...(customersCache || {}),
                ...localCustomersData
            };
            console.log('[CRM] customersData merged count:', Object.keys(customersData).length);
        } catch (mergeError) {
            console.error('[CRM] Error merging customer data:', mergeError);
            customersData = customersCache || {};
        }

        // Gather supporting datasets
        const allEvents = eventsCache.length > 0
            ? eventsCache
            : JSON.parse(localStorage.getItem('events') || '[]');
        const deletedCustomers = getDeletedCustomers();

        console.log('[CRM] eventsCache length:', eventsCache.length, 'allEvents length:', Array.isArray(allEvents) ? allEvents.length : 0);
        console.log('[CRM] deletedCustomers length:', deletedCustomers.length);

        // Analyze customers from CRM data and event history
        const customers = {};

        Object.keys(customersData).forEach(customerName => {
            if (isRefinery(customerName)) return;
            if (deletedCustomers.includes(customerName)) return;

        if (!customers[customerName]) {
            const customerInfo = customersData[customerName] || {};
            customers[customerName] = {
                name: customerName,
                buySheets: 0,
                    totalSpent: 0,
                transactions: [],
                lastTransaction: null,
                trustScore: 0,
                priority: 'Low',
                phone: customerInfo.phone || '',
                email: customerInfo.email || '',
                address: customerInfo.address || '',
                city: customerInfo.city || '',
                state: customerInfo.state || '',
                zip: customerInfo.zip || ''
            };
        }
    });
        (Array.isArray(allEvents) ? allEvents : []).forEach(event => {
            const buyList = event?.buyList || [];
        buyList.forEach(item => {
                if (!item?.customer || !item.customer.trim()) return;

                const customerNames = item.customer.split(',').map(c => c.trim()).filter(Boolean);
                customerNames.forEach(customerName => {
                    if (isRefinery(customerName)) return;
                    if (deletedCustomers.includes(customerName)) return;

                    if (!customers[customerName]) {
                        const customerInfo = customersData[customerName] || {};
                        customers[customerName] = {
                            name: customerName,
                            buySheets: 0,
                            totalSpent: 0,
                            transactions: [],
                            lastTransaction: null,
                            trustScore: 0,
                            priority: 'Low',
                            phone: customerInfo.phone || '',
                            email: customerInfo.email || '',
                            address: customerInfo.address || '',
                            city: customerInfo.city || '',
                            state: customerInfo.state || '',
                            zip: customerInfo.zip || ''
                        };
                    }
                    
                    const transactionDate = item.datePurchased || new Date().toISOString().split('T')[0];
                    customers[customerName].transactions.push({
                        type: 'buy',
                        date: transactionDate,
                        amount: item.offer || 0,
                        item
                    });
                    customers[customerName].totalSpent += (item.offer || 0);
                    
                    if (!customers[customerName].lastTransaction || transactionDate > customers[customerName].lastTransaction) {
                        customers[customerName].lastTransaction = transactionDate;
                    }
                });
        });
    });
    
    if (searchQuery) {
        const searchLower = searchQuery.toLowerCase();
        Object.keys(customers).forEach(customerName => {
            const customer = customers[customerName];
            const phone = (customer.phone || '').toLowerCase();
            const nameMatch = customerName.toLowerCase().includes(searchLower);
            const phoneMatch = phone.includes(searchLower);
            if (!nameMatch && !phoneMatch) {
                delete customers[customerName];
            }
        });
    }
    
    Object.values(customers).forEach(customer => {
        const buyTransactions = customer.transactions.filter(t => t.type === 'buy');
        const uniqueBuySheets = new Set();
        buyTransactions.forEach(t => {
            uniqueBuySheets.add(t.date);
        });
        customer.buySheets = uniqueBuySheets.size;
        
        const transactionCount = customer.transactions.length;
        const totalValue = customer.totalSpent;
        const daysSinceLastTransaction = customer.lastTransaction 
            ? Math.floor((new Date() - new Date(customer.lastTransaction)) / (1000 * 60 * 60 * 24))
            : 999;
        
        let likelihoodScore = 0;
        if (transactionCount === 0) {
            customer.trustScore = 0;
            return;
        }
        
        let avgDaysBetween = 0;
        if (transactionCount > 1) {
            const sortedDates = customer.transactions
                .map(t => new Date(t.date))
                .sort((a, b) => a - b);
            
            const intervals = [];
            for (let i = 1; i < sortedDates.length; i++) {
                    const diff = Math.floor((sortedDates[i] - sortedDates[i - 1]) / (1000 * 60 * 60 * 24));
                intervals.push(diff);
            }
            
            if (intervals.length > 0) {
                avgDaysBetween = intervals.reduce((sum, d) => sum + d, 0) / intervals.length;
            }
        }
        
        if (daysSinceLastTransaction <= 7) {
                likelihoodScore += 40;
        } else if (daysSinceLastTransaction <= 14) {
            likelihoodScore += 35;
        } else if (daysSinceLastTransaction <= 30) {
            likelihoodScore += 30;
        } else if (daysSinceLastTransaction <= 60) {
            likelihoodScore += 20;
        } else if (daysSinceLastTransaction <= 90) {
            likelihoodScore += 10;
        } else if (daysSinceLastTransaction <= 180) {
            likelihoodScore += 5;
        }
        
        if (avgDaysBetween > 0 && avgDaysBetween <= 90) {
            if (daysSinceLastTransaction <= avgDaysBetween * 1.2) {
                likelihoodScore += 35;
            } else if (daysSinceLastTransaction <= avgDaysBetween * 1.5) {
                likelihoodScore += 25;
            } else if (daysSinceLastTransaction <= avgDaysBetween * 2) {
                likelihoodScore += 15;
            } else {
                likelihoodScore += 5;
            }
        } else if (transactionCount >= 3) {
            likelihoodScore += 20;
        } else if (transactionCount === 2) {
            likelihoodScore += 10;
        }
        
        if (transactionCount >= 5) {
                likelihoodScore += 15;
        } else if (transactionCount >= 3) {
                likelihoodScore += 10;
        } else if (transactionCount === 2) {
                likelihoodScore += 5;
        }
        
        const recentTransactions = customer.transactions.filter(t => {
            const transactionDate = new Date(t.date);
            const daysAgo = Math.floor((new Date() - transactionDate) / (1000 * 60 * 60 * 24));
            return daysAgo <= 90;
        }).length;
        
        if (recentTransactions >= 3) {
                likelihoodScore += 10;
        } else if (recentTransactions === 2) {
                likelihoodScore += 5;
        }
        
        customer.trustScore = Math.min(likelihoodScore, 100);
        
        if (customer.trustScore >= 70 || totalValue > 10000) {
            customer.priority = 'High';
        } else if (customer.trustScore >= 40 || totalValue > 2000) {
            customer.priority = 'Medium';
        } else {
            customer.priority = 'Low';
        }
    });
    
        const activeFilter = searchQuery
            ? 'all'
            : (document.querySelector('.customer-filters .filter-btn.active')?.dataset.filter || 'all');
    
        filteredCustomers = Object.values(customers);
    if (!searchQuery) {
        if (activeFilter === 'repeat') {
            filteredCustomers = filteredCustomers.filter(c => c.buySheets > 1 || c.transactions.length > 1);
        } else if (activeFilter === 'high-value') {
            filteredCustomers = filteredCustomers.filter(c => c.totalSpent > 2000);
        } else if (activeFilter === 'priority') {
            filteredCustomers = filteredCustomers.filter(c => c.priority === 'High');
        }
    }
    
    filteredCustomers.sort((a, b) => b.totalSpent - a.totalSpent);
        console.log('[CRM] filteredCustomers count after filters:', filteredCustomers.length);
    
    const totalCustomers = Object.keys(customers).length;
    const repeatCustomers = Object.values(customers).filter(c => c.buySheets > 1 || c.transactions.length > 1).length;
    const highValueCustomers = Object.values(customers).filter(c => c.totalSpent > 2000).length;
    const totalCustomerValue = Object.values(customers).reduce((sum, c) => sum + c.totalSpent, 0);
        console.log('[CRM] Aggregated totals:', { totalCustomers, repeatCustomers, highValueCustomers, totalCustomerValue });
    
    document.getElementById('customer-total-count').textContent = totalCustomers;
    document.getElementById('customer-repeat-count').textContent = repeatCustomers;
    document.getElementById('customer-high-value-count').textContent = highValueCustomers;
    document.getElementById('customer-total-value').textContent = formatCurrency(totalCustomerValue);
    } catch (error) {
        renderError = error;
        console.error('Error rendering customers:', error);
    }

    if (!tbody) {
        return;
    }

    if (renderError) {
        tbody.innerHTML = '<tr><td colspan="9" class="empty-message">Unable to load customers. Check console for details.</td></tr>';
        return;
    }

    if (!filteredCustomers || filteredCustomers.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" class="empty-message">No customers found.</td></tr>';
        return;
    }
    
    tbody.innerHTML = filteredCustomers.map(customer => {
        const isRepeat = customer.buySheets > 1 || customer.transactions.length > 1;
        const isHighValue = customer.totalSpent > 2000;
        const totalValue = customer.totalSpent; // Only show what we paid them
        
        // Trust score color
        let scoreColor = '#666';
        let scoreClass = '';
        if (customer.trustScore >= 70) {
            scoreColor = '#28a745';
            scoreClass = 'high-trust';
        } else if (customer.trustScore >= 40) {
            scoreColor = '#ffc107';
            scoreClass = 'medium-trust';
        } else {
            scoreColor = '#dc3545';
            scoreClass = 'low-trust';
        }
        
        // Priority badge
        let priorityBadge = '';
        let priorityClass = '';
        if (customer.priority === 'High') {
            priorityBadge = '⭐ High';
            priorityClass = 'priority-high';
        } else if (customer.priority === 'Medium') {
            priorityBadge = '✓ Medium';
            priorityClass = 'priority-medium';
        } else {
            priorityBadge = '○ Low';
            priorityClass = 'priority-low';
        }
        
        // Format contact info - cleaner display
        const contactInfo = [];
        if (customer.phone) contactInfo.push(`<div style="margin-bottom: 0.5rem;"><strong>📞</strong> ${customer.phone}</div>`);
        if (customer.email) contactInfo.push(`<div style="margin-bottom: 0.5rem;"><strong>✉️</strong> ${customer.email}</div>`);
        if (customer.address || customer.city) {
            const addressParts = [customer.address, customer.city, customer.state, customer.zip].filter(p => p).join(', ');
            if (addressParts) contactInfo.push(`<div><strong>📍</strong> ${addressParts}</div>`);
        }
        const contactDisplay = contactInfo.length > 0 
            ? `<div style="font-size: 0.9rem; line-height: 1.6; color: #333;">${contactInfo.join('')}</div>`
            : '<span style="color: #999; font-style: italic; font-size: 0.85rem;">No contact info</span>';
        
        return `
            <tr class="customer-row ${isHighValue ? 'high-value-row' : ''}" onclick="openCustomerProfile('${customer.name.replace(/'/g, "\\'")}')" style="cursor: pointer;">
                <td style="min-width: 180px;">
                    <div style="font-size: 1.1rem; font-weight: 600; color: #333; margin-bottom: 0.25rem;">${customer.name}</div>
                </td>
                <td style="min-width: 220px;">${contactDisplay}</td>
                <td style="text-align: center; min-width: 100px;">
                    <div style="font-size: 1.1rem; font-weight: 600; color: #d4af37;">${customer.buySheets}</div>
                </td>
                <td style="min-width: 120px;">
                    <div style="font-size: 1.1rem; font-weight: 600; color: #28a745;">${formatCurrency(totalValue)}</div>
                </td>
                <td style="min-width: 180px;">
                    <div class="trust-score" style="flex-direction: column; align-items: flex-start; gap: 0.5rem;">
                        <div style="display: flex; align-items: center; gap: 0.5rem; width: 100%;">
                            <span class="trust-score-value ${scoreClass}" style="color: ${scoreColor}; font-size: 1.1rem; min-width: 45px;">
                                ${customer.trustScore}%
                            </span>
                            <div class="trust-score-bar" style="flex: 1;">
                                <div class="trust-score-fill" style="width: ${customer.trustScore}%; background-color: ${scoreColor}"></div>
                            </div>
                        </div>
                        <small style="color: #666; font-size: 0.8rem;">
                            ${getLikelihoodLabel(customer.trustScore)}
                        </small>
                    </div>
                </td>
                <td style="text-align: center; min-width: 120px;">
                    <span class="priority-badge ${priorityClass}">${priorityBadge}</span>
                </td>
                <td style="min-width: 120px; color: #666;">
                    <div style="font-size: 0.9rem;">${customer.lastTransaction || 'N/A'}</div>
                </td>
                <td style="min-width: 220px;">
                    <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; justify-content: flex-start;">
                        <button class="btn-secondary btn-sm" style="padding: 0.4rem 0.8rem;" onclick="event.stopPropagation(); event.preventDefault(); openCustomerProfile('${customer.name.replace(/'/g, "\\'")}'); return false;">View</button>
                        <button class="btn-secondary btn-sm" style="background: #ef4444; color: white; border-color: #ef4444; padding: 0.4rem 0.8rem;" onclick="event.stopPropagation(); event.preventDefault(); deleteCustomerConfirm('${customer.name.replace(/'/g, "\\'")}'); return false;">Delete</button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

function getLikelihoodLabel(score) {
    if (score >= 80) return 'Very High';
    if (score >= 60) return 'High';
    if (score >= 40) return 'Moderate';
    if (score >= 20) return 'Low';
    return 'Very Low';
}
function openCustomerProfile(customerName) {
    // Get customer CRM info
    const customerInfo = getCustomerInfo(customerName);
    const allEvents = (eventsCache && eventsCache.length > 0)
        ? eventsCache
        : JSON.parse(localStorage.getItem('events') || '[]');
    
    // Set customer name in modal
    document.getElementById('customer-profile-name').textContent = customerName;
    
    // Fill contact information
    document.getElementById('profile-phone').textContent = customerInfo?.phone || '-';
    document.getElementById('profile-email').textContent = customerInfo?.email || '-';
    
    // Build address
    let address = '-';
    if (customerInfo?.address || customerInfo?.city) {
        const addressParts = [customerInfo.address, customerInfo.city, customerInfo.state, customerInfo.zip].filter(p => p);
        if (addressParts.length > 0) {
            address = addressParts.join(', ');
        }
    }
    document.getElementById('profile-address').textContent = address;
    // Find all buy sheets for this customer
    // Group items by buySheetId to create one buy sheet per confirmation
    const buySheetsMap = {}; // key: buySheetId, value: buy sheet data
    
    allEvents.forEach(event => {
        const buyList = event.buyList || [];
        
        buyList.forEach(item => {
            if (item.customer && item.customer.includes(customerName)) {
                // Get the buySheetId (could be single ID or array)
                let buySheetIds = [];
                if (item.buySheetId) {
                    buySheetIds.push(item.buySheetId);
                } else if (item.buySheetIds && Array.isArray(item.buySheetIds)) {
                    buySheetIds = item.buySheetIds;
                } else {
                    // Fallback: use datePurchased + customer as unique key
                    const fallbackKey = `${item.datePurchased || 'unknown'}_${item.customer || 'unknown'}`;
                    buySheetIds.push(fallbackKey);
                }
                
                // Process each buySheetId this item belongs to
                buySheetIds.forEach(buySheetId => {
                    if (!buySheetsMap[buySheetId]) {
                        // Create new buy sheet entry
                        buySheetsMap[buySheetId] = {
                            buySheetId: buySheetId,
                            date: item.datePurchased,
                            amount: 0,
                            totalWeight: 0,
                            totalMelt: 0,
                            categories: [],
                            descriptions: [],
                            items: [],
                            eventName: event.name || 'Unknown Event',
                            notes: item.notes || '',
                            checkNumber: item.checkNumber || ''
                        };
                    }
                    
                    // Add item data to this buy sheet
                    const buySheet = buySheetsMap[buySheetId];
                    buySheet.amount += (item.offer || 0);
                    buySheet.totalWeight += (item.weight || 0);
                    buySheet.totalMelt += (item.fullMelt || 0);
                    
                    // Add category and description (avoid duplicates)
                    const category = item.category || 'N/A';
                    if (!buySheet.categories.includes(category)) {
                        buySheet.categories.push(category);
                    }
                    
                    const description = item.description || (item.metal && item.karat ? `${item.metal} ${item.karat}K` : 'N/A');
                    buySheet.descriptions.push(description);
                    
                    // Store full item for detail view
                    buySheet.items.push({
                        category: category,
                        description: description,
                        weight: item.weight || 0,
                        metal: item.metal || 'N/A',
                        karat: item.karat || 'N/A',
                        fullMelt: item.fullMelt || 0,
                        offer: item.offer || 0,
                        notes: item.notes || ''
                    });
                });
            }
        });
    });
    
    // Convert map to array
    const buySheets = Object.values(buySheetsMap).map(buySheet => ({
        date: buySheet.date,
        amount: buySheet.amount,
        category: buySheet.categories.join(', '),
        description: buySheet.descriptions.length === 1 
            ? buySheet.descriptions[0] 
            : `${buySheet.descriptions.length} items`,
        weight: buySheet.totalWeight,
        metal: buySheet.items.length === 1 && buySheet.items[0].metal !== 'N/A' 
            ? buySheet.items[0].metal 
            : 'Multiple',
        karat: buySheet.items.length === 1 && buySheet.items[0].karat !== 'N/A' 
            ? buySheet.items[0].karat 
            : 'Multiple',
        fullMelt: buySheet.totalMelt,
        offer: buySheet.amount,
        eventName: buySheet.eventName,
        notes: buySheet.notes,
        checkNumber: buySheet.checkNumber,
        items: buySheet.items // Store all items for detail view
    }));
    
    // Calculate totals
    const totalSpent = buySheets.reduce((sum, t) => sum + t.amount, 0);
    const avgTransaction = buySheets.length > 0 ? totalSpent / buySheets.length : 0;
    
    // Calculate likelihood info
    const sortedDates = buySheets.map(t => new Date(t.date)).sort((a, b) => a - b);
    let avgDaysBetween = 0;
    if (sortedDates.length > 1) {
        const intervals = [];
        for (let i = 1; i < sortedDates.length; i++) {
            intervals.push(Math.floor((sortedDates[i] - sortedDates[i-1]) / (1000 * 60 * 60 * 24)));
        }
        avgDaysBetween = Math.round(intervals.reduce((sum, d) => sum + d, 0) / intervals.length);
    }
    const lastTransaction = sortedDates[sortedDates.length - 1];
    const daysSinceLast = lastTransaction ? Math.floor((new Date() - lastTransaction) / (1000 * 60 * 60 * 24)) : null;
    
    // Update summary stats
    document.getElementById('profile-total-sheets').textContent = buySheets.length;
    document.getElementById('profile-total-paid').textContent = formatCurrency(totalSpent);
    document.getElementById('profile-avg-transaction').textContent = formatCurrency(avgTransaction);
    document.getElementById('profile-last-transaction').textContent = lastTransaction ? lastTransaction.toISOString().split('T')[0] : '-';
    
    if (avgDaysBetween > 0) {
        document.getElementById('profile-days-between-container').style.display = 'block';
        document.getElementById('profile-days-between').textContent = `${avgDaysBetween} days`;
    } else {
        document.getElementById('profile-days-between-container').style.display = 'none';
    }
    
    if (daysSinceLast !== null) {
        document.getElementById('profile-days-since-container').style.display = 'block';
        document.getElementById('profile-days-since').textContent = `${daysSinceLast} days`;
    } else {
        document.getElementById('profile-days-since-container').style.display = 'none';
    }
    
    // Render buy sheets as cards with better design
    const buySheetsList = document.getElementById('profile-buy-sheets-list');
    if (buySheets.length === 0) {
        buySheetsList.innerHTML = '<div class="empty-message" style="padding: 2rem; text-align: center; color: var(--text-muted); background: var(--bg-surface); border-radius: var(--radius);">No buy sheets found for this customer.</div>';
    } else {
        buySheetsList.innerHTML = `
            <div class="buy-sheets-grid">
                    ${buySheets
                        .sort((a, b) => new Date(b.date) - new Date(a.date))
                    .map((sheet, index) => {
                        const formattedDate = new Date(sheet.date).toLocaleDateString('en-US', { 
                            month: 'short', 
                            day: 'numeric', 
                            year: 'numeric' 
                        });
                        const daysAgo = Math.floor((new Date() - new Date(sheet.date)) / (1000 * 60 * 60 * 24));
                        const daysAgoText = daysAgo === 0 ? 'Today' : daysAgo === 1 ? 'Yesterday' : `${daysAgo} days ago`;
                        
                        return `
                            <div class="buy-sheet-card" onclick="event.stopPropagation(); openBuySheetDetail(${index}, '${customerName.replace(/'/g, "\\'")}')">
                                <div class="buy-sheet-card-header">
                                    <div class="buy-sheet-card-number">#${buySheets.length - index}</div>
                                    <div class="buy-sheet-card-date-badge">${daysAgoText}</div>
                                </div>
                                <div class="buy-sheet-card-body">
                                    <div class="buy-sheet-card-amount">${formatCurrency(sheet.amount)}</div>
                                    <div class="buy-sheet-card-meta">
                                        <div class="buy-sheet-card-meta-item">
                                            <span class="meta-icon">📅</span>
                                            <span>${formattedDate}</span>
                                        </div>
                                        <div class="buy-sheet-card-meta-item">
                                            <span class="meta-icon">📦</span>
                                            <span>${sheet.items ? sheet.items.length : 1} ${(sheet.items && sheet.items.length === 1) ? 'item' : 'items'}</span>
                                        </div>
                                        <div class="buy-sheet-card-meta-item">
                                            <span class="meta-icon">🏷️</span>
                                            <span>${sheet.category || 'N/A'}</span>
                                        </div>
                                        ${sheet.checkNumber ? `
                                        <div class="buy-sheet-card-meta-item">
                                            <span class="meta-icon">🔖</span>
                                            <span>Check #${sheet.checkNumber}</span>
                                        </div>
                                        ` : ''}
                                    </div>
                                    <div class="buy-sheet-card-event">
                                        <span class="event-icon">📍</span>
                                        ${sheet.eventName || 'Unknown Event'}
                                    </div>
                                </div>
                                <div class="buy-sheet-card-footer">
                                    <button class="btn-primary btn-sm" onclick="event.stopPropagation(); event.preventDefault(); openBuySheetDetail(${index}, '${customerName.replace(/'/g, "\\'")}')">View Details</button>
                                </div>
                            </div>
                        `;
                    }).join('')}
            </div>
        `;
    }
    
    // Store buy sheets data for detail modal
    window.currentCustomerBuySheets = buySheets.sort((a, b) => new Date(b.date) - new Date(a.date));
    window.currentCustomerName = customerName;
    
    // Open modal - center it
    const modal = document.getElementById('customer-profile-modal');
    modal.style.display = 'flex';
    modal.style.alignItems = 'center';
    modal.style.justifyContent = 'center';
}

// Keep old function for backward compatibility
function viewCustomerDetails(customerName) {
    openCustomerProfile(customerName);
}

function searchCustomers() {
    const searchInput = document.getElementById('customer-search-input');
    const query = searchInput.value.trim();
    currentCustomerSearch = query || null;
    renderCustomers(currentCustomerSearch);
}

function clearCustomerSearch() {
    document.getElementById('customer-search-input').value = '';
    currentCustomerSearch = null;
    renderCustomers();
}

function normalizeCheckNumber(value) {
    return value ? value.toString().trim().toLowerCase() : null;
}

async function isCheckNumberInUse(checkNumber) {
    const normalized = normalizeCheckNumber(checkNumber);
    if (!normalized) {
        return false;
    }

    const currentSheetIdRaw = currentBuySheet ? (currentBuySheet.sheetId || currentBuySheet.buySheetId || null) : null;
    const currentSheetId = currentSheetIdRaw ? currentSheetIdRaw.toString().toLowerCase() : null;

    const hasConflictingMatch = (entries) => {
        if (!Array.isArray(entries)) return false;

        for (const entry of entries) {
            if (!entry) continue;

            const entryCheck = normalizeCheckNumber(entry.checkNumber);
            if (!entryCheck || entryCheck !== normalized) {
                continue;
            }

            const entrySheetIdRaw = entry.buySheetId || null;
            if (entrySheetIdRaw && currentSheetId) {
                if (entrySheetIdRaw.toString().toLowerCase() === currentSheetId) {
                    continue;
                }
            }

            return true;
        }

        return false;
    };

    const cachedEvents = Array.isArray(eventsCache) ? eventsCache : [];
    if (hasConflictingMatch(buildCheckNumberResultsFromEvents(cachedEvents, checkNumber))) {
        return true;
    }

    if (typeof localStorage !== 'undefined') {
        try {
            const localEvents = JSON.parse(localStorage.getItem('events') || '[]');
            if (hasConflictingMatch(buildCheckNumberResultsFromEvents(localEvents, checkNumber))) {
                return true;
            }
        } catch (error) {
            console.warn('Unable to parse events from localStorage for check validation:', error);
        }
    }

    if (hasConflictingMatch(collectCheckNumberResultsFromQueue(checkNumber))) {
        return true;
    }

    if (typeof fetchCheckNumberMatchesFromDB === 'function') {
        const dbResults = await fetchCheckNumberMatchesFromDB(checkNumber);
        if (hasConflictingMatch(dbResults)) {
            return true;
        }
    }

    return false;
}

function buildCheckNumberResultsFromEvents(events, checkNumber) {
    const matches = [];
    if (!Array.isArray(events) || !checkNumber) return matches;

    const normalized = normalizeCheckNumber(checkNumber);

    events.forEach(event => {
        if (!event) return;
        const buyList = Array.isArray(event.buyList) ? event.buyList : [];
        buyList.forEach(item => {
            const itemCheck = normalizeCheckNumber(item?.checkNumber);
            if (!itemCheck || itemCheck !== normalized) return;

            matches.push({
                    event: event.name || 'Unknown Event',
                customer: item.customer || event.customer || 'Unknown',
                date: item.datePurchased || event.date || event.created || 'Unknown',
                amount: Number(item.offer) || 0,
                    category: item.category || 'N/A',
                    description: item.description || (item.metal && item.karat ? `${item.metal} ${item.karat}K` : 'N/A'),
                weight: Number(item.weight) || 0,
                    metal: item.metal || 'N/A',
                    karat: item.karat || 'N/A',
                fullMelt: Number(item.fullMelt || item.meltValue) || 0,
                notes: item.notes || event.notes || '',
                checkNumber: item.checkNumber,
                buySheetId: item.buySheetId || (Array.isArray(item.buySheetIds) ? item.buySheetIds[0] : null)
            });
        });
    });

    return matches;
}

function collectCheckNumberResultsFromQueue(checkNumber) {
    const matches = [];
    const normalized = normalizeCheckNumber(checkNumber);
    if (!normalized) return matches;

    let queue = [];
    try {
        queue = JSON.parse(localStorage.getItem('syncQueue') || '[]');
    } catch (error) {
        console.warn('Unable to parse syncQueue for check lookup:', error);
        return matches;
    }

    if (!Array.isArray(queue)) return matches;

    queue.forEach(op => {
        if (!op || !op.type || !op.data) return;

        if (op.type === 'saveEvent' && op.data.event) {
            matches.push(...buildCheckNumberResultsFromEvents([op.data.event], checkNumber));
        }

        if (op.type === 'saveBuySheet' && op.data.buySheet) {
            const sheet = op.data.buySheet;
            const sheetCheck = normalizeCheckNumber(sheet.checkNumber || sheet.check_number);
            if (!sheetCheck || sheetCheck !== normalized) return;

            const event = op.data.eventId ? getEvent(op.data.eventId) : null;
            matches.push({
                event: event?.name || 'Queued Event',
                customer: sheet.customer || 'Unknown',
                date: sheet.updated_at || sheet.created_at || new Date().toISOString().split('T')[0],
                amount: Number(sheet.totalOffer || 0),
                category: 'N/A',
                description: 'Queued Buy Sheet',
                weight: 0,
                metal: 'N/A',
                karat: 'N/A',
                fullMelt: 0,
                notes: sheet.notes || '',
                checkNumber: sheet.checkNumber || sheet.check_number || checkNumber,
                buySheetId: sheet.buySheetId || sheet.buy_sheet_id || null
            });
        }
    });

    return matches;
}

function collectCurrentBuySheetResults(checkNumber) {
    const matches = [];
    if (!currentBuySheet) return matches;

    const normalized = normalizeCheckNumber(checkNumber);
    if (!normalized) return matches;

    const eventInfo = currentEvent ? getEvent(currentEvent) : null;
    const items = Array.isArray(currentBuySheet.items) ? currentBuySheet.items : [];

    items.forEach(item => {
        const itemCheck = normalizeCheckNumber(item?.checkNumber || currentBuySheet.checkNumber);
        if (!itemCheck || itemCheck !== normalized) return;

        matches.push({
            event: eventInfo?.name || 'Current Event',
            customer: currentBuySheet.customer || item.customer || 'Unknown',
            date: item.datePurchased || eventInfo?.date || new Date().toISOString().split('T')[0],
            amount: Number(item.offer) || 0,
            category: item.category || 'N/A',
            description: item.description || (item.metal && item.karat ? `${item.metal} ${item.karat}K` : 'N/A'),
            weight: Number(item.weight) || 0,
            metal: item.metal || 'N/A',
            karat: item.karat || 'N/A',
            fullMelt: Number(item.fullMelt || item.meltValue) || 0,
            notes: item.notes || currentBuySheet.notes || '',
            checkNumber: item.checkNumber || currentBuySheet.checkNumber || checkNumber,
            buySheetId: currentBuySheet.sheetId || currentBuySheet.buySheetId || null
        });
    });

    return matches;
}

function groupCheckNumberResults(results) {
    const map = {};

    (results || []).forEach(result => {
        const sheetKey = result.buySheetId || `local_${result.event}_${result.checkNumber}`;
        if (!map[sheetKey]) {
            map[sheetKey] = {
                buySheetId: sheetKey,
                customer: result.customer,
                date: result.date,
                event: result.event,
                totalAmount: 0,
                totalWeight: 0,
                totalMelt: 0,
                items: [],
                notes: result.notes || '',
                checkNumber: result.checkNumber || null
            };
        }

        const entry = map[sheetKey];
        entry.totalAmount += Number(result.amount) || 0;
        entry.totalWeight += Number(result.weight) || 0;
        entry.totalMelt += Number(result.fullMelt) || 0;
        entry.items.push({
            category: result.category,
            description: result.description,
            weight: Number(result.weight) || 0,
            metal: result.metal,
            karat: result.karat,
            fullMelt: Number(result.fullMelt) || 0,
            offer: Number(result.amount) || 0
        });
    });
    
    return Object.values(map);
}
    
function renderCheckNumberResults(checkNumber, buySheets) {
    const resultsDiv = document.getElementById('check-number-results');
    if (!resultsDiv) return;

    if (!buySheets || buySheets.length === 0) {
        resultsDiv.innerHTML = `
            <div class="empty-message" style="padding: 1rem; background: #f8f9fa; border-radius: 6px; text-align: center;">
                No results found for check number: <strong>${checkNumber}</strong>
            </div>
        `;
        resultsDiv.style.display = 'block';
        return;
    }
    
    resultsDiv.innerHTML = `
        <div style="background: white; border: 1px solid #e9ecef; border-radius: 8px; padding: 1.5rem; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
            <h4 style="margin-bottom: 1rem; color: #d4af37; border-bottom: 2px solid #d4af37; padding-bottom: 0.5rem;">
                Check Number: <strong>${checkNumber}</strong>
            </h4>
            ${buySheets.map((buySheet, index) => `
                <div style="margin-bottom: ${index < buySheets.length - 1 ? '2rem' : '0'}; padding-bottom: ${index < buySheets.length - 1 ? '2rem' : '0'}; border-bottom: ${index < buySheets.length - 1 ? '1px solid #e9ecef' : 'none'};">
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 1rem;">
                        <div>
                            <label style="font-size: 0.85rem; color: #666; font-weight: 600;">Customer:</label>
                            <div style="font-size: 1rem; font-weight: 600; color: #333;">${buySheet.customer}</div>
                        </div>
                        <div>
                            <label style="font-size: 0.85rem; color: #666; font-weight: 600;">Date:</label>
                            <div style="font-size: 1rem; color: #333;">${buySheet.date}</div>
                        </div>
                        <div>
                            <label style="font-size: 0.85rem; color: #666; font-weight: 600;">Event:</label>
                            <div style="font-size: 1rem; color: #333;">${buySheet.event}</div>
                        </div>
                        <div>
                            <label style="font-size: 0.85rem; color: #666; font-weight: 600;">Total Amount:</label>
                            <div style="font-size: 1.2rem; font-weight: bold; color: #d4af37;">${formatCurrency(buySheet.totalAmount)}</div>
                        </div>
                        <div>
                            <label style="font-size: 0.85rem; color: #666; font-weight: 600;">Total Weight:</label>
                            <div style="font-size: 1rem; color: #333;">${Number(buySheet.totalWeight || 0).toFixed(2)} g</div>
                        </div>
                    </div>
                    
                    <div style="margin-top: 1rem;">
                        <label style="font-size: 0.85rem; color: #666; font-weight: 600; margin-bottom: 0.5rem; display: block;">Items Purchased (${buySheet.items.length}):</label>
                        <div style="overflow-x: auto;">
                            <table class="data-table" style="width: 100%; margin-top: 0;">
                                <thead>
                                    <tr>
                                        <th>Category</th>
                                        <th>Description</th>
                                        <th>Weight</th>
                                        <th>Melt Value</th>
                                        <th>Offer</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${buySheet.items.map(item => `
                                        <tr>
                                            <td>${item.category}</td>
                                            <td>${item.description}</td>
                                            <td>${Number(item.weight || 0).toFixed(2)}g</td>
                                            <td>${formatCurrency(item.fullMelt)}</td>
                                            <td>${formatCurrency(item.offer)}</td>
                                        </tr>
                                    `).join('')}
                                    <tr style="background: #f8f9fa; font-weight: bold;">
                                        <td colspan="2">Total:</td>
                                        <td>${Number(buySheet.totalWeight || 0).toFixed(2)}g</td>
                                        <td>${formatCurrency(buySheet.totalMelt)}</td>
                                        <td>${formatCurrency(buySheet.totalAmount)}</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                    
                    ${buySheet.notes ? `
                    <div style="margin-top: 1rem; padding: 0.75rem; background: #fff3cd; border-radius: 6px; border-left: 3px solid #ffc107;">
                        <label style="font-size: 0.85rem; color: #666; font-weight: 600; display: block; margin-bottom: 0.25rem;">Notes:</label>
                        <div style="font-size: 0.95rem; color: #555; font-style: italic;">${buySheet.notes}</div>
                    </div>
                    ` : ''}
                    
                    <div style="margin-top: 1rem;">
                        <button class="btn-primary btn-sm" onclick="viewCustomerFromCheck('${buySheet.customer.replace(/'/g, "\\'")}')">
                            View Customer Profile
                        </button>
                    </div>
                </div>
            `).join('')}
        </div>
    `;
    resultsDiv.style.display = 'block';
}
async function fetchCheckNumberMatchesFromDB(checkNumber) {
    if (!USE_SUPABASE || !supabase) {
        return [];
    }
    try {
        if (!checkNumber) return [];
        if (typeof isOnline !== 'undefined' && !isOnline) return [];

        let userId;
        try {
            userId = getUserId();
        } catch (error) {
            console.warn('Unable to determine user ID for check number lookup:', error);
            return [];
        }

        const normalized = normalizeCheckNumber(checkNumber);
        const results = [];

        const eventsById = {};
        const cachedEvents = Array.isArray(eventsCache) ? eventsCache : [];
        cachedEvents.forEach(event => {
            if (event?.id) eventsById[event.id] = event;
        });
        try {
            const storedEvents = JSON.parse(localStorage.getItem('events') || '[]');
            if (Array.isArray(storedEvents)) {
                storedEvents.forEach(event => {
                    if (event?.id && !eventsById[event.id]) {
                        eventsById[event.id] = event;
                    }
                });
            }
        } catch (error) {
            console.warn('Unable to parse local events for check lookup:', error);
        }

        const { data: sheetRows, error: sheetError } = await supabase
            .from('buy_sheets')
            .select('id, buy_sheet_id, event_id, customer, notes, status, check_number, updated_at, created_at')
            .eq('user_id', userId)
            .eq('check_number', checkNumber)
            .not('check_number', 'is', null);

        if (sheetError && sheetError.code !== '42P01') throw sheetError;
        const sheetData = Array.isArray(sheetRows) ? sheetRows : [];
        const sheetIdSet = new Set(sheetData.map(sheet => sheet?.buy_sheet_id).filter(Boolean));

        let itemsData = [];
        if (sheetIdSet.size > 0) {
            const { data: itemsForSheets, error: itemsError } = await supabase
                .from('buy_list_items')
                .select('*')
                .eq('user_id', userId)
                .in('buy_sheet_id_string', Array.from(sheetIdSet));

            if (itemsError && itemsError.code !== '42P01') throw itemsError;
            if (Array.isArray(itemsForSheets)) {
                itemsData = itemsForSheets.slice();
            }
        }

        const { data: directItems, error: directItemsError } = await supabase
            .from('buy_list_items')
            .select('*')
            .eq('user_id', userId)
            .eq('check_number', checkNumber)
            .not('check_number', 'is', null);

        if (directItemsError && directItemsError.code !== '42P01') throw directItemsError;
        if (Array.isArray(directItems)) {
            const seenItemIds = new Set(itemsData.map(item => item?.id));
            directItems.forEach(item => {
                if (item && !seenItemIds.has(item.id)) {
                    itemsData.push(item);
                }
            });
        }

        const sheetById = {};
        sheetData.forEach(sheet => {
            if (sheet?.buy_sheet_id) {
                sheetById[sheet.buy_sheet_id] = sheet;
            }
        });

        const pushResultFromItem = (item) => {
            if (!item) return;
            const sheet = item.buy_sheet_id_string ? sheetById[item.buy_sheet_id_string] : null;
            const eventInfo = sheet?.event_id ? eventsById[sheet.event_id] : (item.event_id ? eventsById[item.event_id] : null);

            results.push({
                event: eventInfo?.name || sheet?.event_name || 'Unknown Event',
                customer: sheet?.customer || item.customer || 'Unknown',
                date: item.date_purchased || item.created_at || sheet?.updated_at || sheet?.created_at || 'Unknown',
                amount: Number(item.offer) || 0,
                category: item.category || item.item_name || 'N/A',
                description: item.description || item.item_name || (sheet?.customer ? `${sheet.customer} Item` : 'Item'),
                weight: Number(item.weight) || 0,
                metal: item.metal || 'N/A',
                karat: item.karat || 'N/A',
                fullMelt: Number(item.full_melt || item.melt_value) || 0,
                notes: sheet?.notes || item.notes || '',
                checkNumber: sheet?.check_number || item.check_number || checkNumber,
                buySheetId: sheet?.buy_sheet_id || item.buy_sheet_id_string || null
            });
        };

        itemsData.forEach(pushResultFromItem);

        sheetData.forEach(sheet => {
            if (!sheet?.buy_sheet_id) return;
            const hasItem = itemsData.some(item => item?.buy_sheet_id_string === sheet.buy_sheet_id);
            if (hasItem) return;

            const eventInfo = sheet.event_id ? eventsById[sheet.event_id] : null;
            results.push({
                event: eventInfo?.name || sheet.event_name || 'Unknown Event',
                customer: sheet.customer || 'Unknown',
                date: sheet.updated_at || sheet.created_at || 'Unknown',
                amount: 0,
                category: 'N/A',
                description: 'Buy Sheet',
                weight: 0,
                metal: 'N/A',
                karat: 'N/A',
                fullMelt: 0,
                notes: sheet.notes || '',
                checkNumber: sheet.check_number || checkNumber,
                buySheetId: sheet.buy_sheet_id
            });
        });

        return results.filter(result => normalizeCheckNumber(result.checkNumber) === normalized);
    } catch (error) {
        console.error('Error searching check number in Supabase:', error);
        return [];
    }
}

async function searchByCheckNumber() {
    const input = document.getElementById('check-number-search-input');
    const checkNumber = input ? input.value.trim() : '';

    if (!checkNumber) {
        alert('Please enter a check number');
        return;
    }

    let results = [];

    const cachedEvents = Array.isArray(eventsCache) ? eventsCache : [];
    if (cachedEvents.length) {
        results = results.concat(buildCheckNumberResultsFromEvents(cachedEvents, checkNumber));
    }

    try {
        const localEvents = JSON.parse(localStorage.getItem('events') || '[]');
        if (Array.isArray(localEvents) && localEvents.length) {
            results = results.concat(buildCheckNumberResultsFromEvents(localEvents, checkNumber));
        }
    } catch (error) {
        console.warn('Unable to parse local events for check lookup:', error);
    }

    results = results.concat(collectCheckNumberResultsFromQueue(checkNumber));
    results = results.concat(collectCurrentBuySheetResults(checkNumber));

    if (!results.length) {
        const dbResults = await fetchCheckNumberMatchesFromDB(checkNumber);
        if (Array.isArray(dbResults) && dbResults.length) {
            results = results.concat(dbResults);
        }
    }

    const buySheets = groupCheckNumberResults(results);
    renderCheckNumberResults(checkNumber, buySheets);
}

function clearCheckNumberSearch() {
    document.getElementById('check-number-search-input').value = '';
    const resultsDiv = document.getElementById('check-number-results');
    if (resultsDiv) {
        resultsDiv.style.display = 'none';
        resultsDiv.innerHTML = '';
    }
}

function viewCustomerFromCheck(customerName) {
    // Clear check number search
    clearCheckNumberSearch();
    
    // Switch to Customers tab
    const customersTab = document.querySelector('[data-tab="customers"]');
    if (customersTab) {
        customersTab.click();
    }
    
    // Open customer profile
    setTimeout(() => {
        openCustomerProfile(customerName);
    }, 100);
}

// Event Management
async function loadEvents(forceRefresh = false) {
    void forceRefresh;
    const selector = document.getElementById('event-selector');
    if (!selector) return;
    
    selector.innerHTML = '<option value=\"\">Select Event</option>';

    let events = Array.isArray(eventsCache) ? [...eventsCache] : [];

    if (events.length === 0) {
        try {
            const storedEvents = JSON.parse(localStorage.getItem('events') || '[]');
            if (Array.isArray(storedEvents) && storedEvents.length) {
                events = storedEvents;
            }
        } catch (error) {
            console.warn('Unable to parse events from localStorage:', error);
        }
    }

    if (!Array.isArray(events)) {
        events = [];
    }

    events = events.map(evt => {
        if (!evt) return null;
        return {
            ...evt,
            buyList: Array.isArray(evt.buyList) ? evt.buyList : [],
            sales: Array.isArray(evt.sales) ? evt.sales : [],
            expenses: Array.isArray(evt.expenses) ? evt.expenses : []
        };
    }).filter(Boolean);

    eventsCache = events;

    (events || []).forEach(event => {
        if (!event) return;
        const option = document.createElement('option');
        const optionValue = event.id || event.tempId || event.name || '';
        option.value = optionValue;
        const dateLabel = event.created || event.date || '';
        option.textContent = dateLabel ? `${event.name || 'Untitled Event'} (${dateLabel})` : (event.name || 'Untitled Event');
        selector.appendChild(option);
    });
    
    updateDeleteButtonVisibility();

    try {
        const storedCurrentEvent = localStorage.getItem('currentEvent');
        if (storedCurrentEvent && selector.querySelector(`option[value=\"${storedCurrentEvent}\"]`)) {
            selector.value = storedCurrentEvent;
        }
    } catch (error) {
        console.warn('Unable to restore current event from storage:', error);
    }
}

// Update delete button visibility based on selected event
function updateDeleteButtonVisibility() {
    const deleteBtn = document.getElementById('delete-event-btn');
    const selector = document.getElementById('event-selector');
    
    if (deleteBtn && selector) {
        if (selector.value && selector.value !== '') {
            deleteBtn.style.display = 'inline-flex';
        } else {
            deleteBtn.style.display = 'none';
        }
    }
}
async function createNewEvent(e) {
    e.preventDefault();
    const eventName = document.getElementById('event-name').value;
    
    if (!eventName.trim()) {
        alert('Please enter an event name');
        return;
    }

    const newEvent = {
        id: null, // Will be set by Supabase
        name: eventName,
        created: new Date().toISOString().split('T')[0],
        date: new Date().toISOString().split('T')[0],
        status: 'active',
        buyList: [],
        sales: [],
        expenses: []
    };

    try {
        // Save to Supabase
        console.log('Creating new event:', newEvent);
        const eventId = await saveEventToDB(newEvent);
        console.log('Event created with ID:', eventId);
        newEvent.id = eventId;
        
        // Update cache
        eventsCache.push(newEvent);
        console.log('Events cache updated, total events:', eventsCache.length);
        
        // Fallback to localStorage
        const events = JSON.parse(localStorage.getItem('events') || '[]');
        events.push(newEvent);
        localStorage.setItem('events', JSON.stringify(events));
        
        await loadEvents();
        document.getElementById('event-selector').value = newEvent.id;
        loadEvent();
        closeModals();
        document.getElementById('new-event-form').reset();
        
        console.log('Event creation complete');
    } catch (error) {
        console.error('Error creating event:', error);
        console.error('Error details:', error.message, error.stack);
        alert('Error creating event: ' + (error.message || 'Unknown error. Check console for details.'));
        // Fallback to localStorage only
        newEvent.id = Date.now().toString();
        const events = JSON.parse(localStorage.getItem('events') || '[]');
        events.push(newEvent);
        localStorage.setItem('events', JSON.stringify(events));
        
        loadEvents();
        document.getElementById('event-selector').value = newEvent.id;
        loadEvent();
        closeModals();
        document.getElementById('new-event-form').reset();
    }
}
function loadEvent() {
    const eventId = document.getElementById('event-selector').value;
    
    try {
        if (eventId) {
            localStorage.setItem('currentEvent', eventId);
        } else {
            localStorage.removeItem('currentEvent');
        }
    } catch (storageError) {
        console.warn('Unable to persist current event selection:', storageError);
    }
    
    // Update delete button visibility
    updateDeleteButtonVisibility();
    
    if (!eventId) {
        currentEvent = null;
        renderBuyList();
        renderSales();
        renderExpenses();
        updateDashboard();
        return;
    }

    currentEvent = eventId;
    loadBuySheet();
    renderBuyList();
    renderSales();
    renderExpenses();
    recalculatePL();
    updateDashboard();
}
// Delete event from main event system
async function deleteMainEvent() {
    const selector = document.getElementById('event-selector');
    const eventId = selector.value;
    
    if (!eventId) {
        alert('Please select an event to delete');
        return;
    }
    
    const event = getEvent(eventId);
    if (!event) {
        alert('Event not found');
        return;
    }
    
    // Confirm deletion
    const confirmMessage = `Are you sure you want to delete "${event.name}"?\n\nThis will permanently delete:\n- All buy list items\n- All sales records\n- All expenses\n- All P/L data\n\nThis action cannot be undone.`;
    
    if (!confirm(confirmMessage)) {
        return;
    }
    
    // Delete from localStorage immediately (for offline mode)
    eventsCache = eventsCache.filter(e => e.id !== eventId && e.tempId !== eventId);
        const events = JSON.parse(localStorage.getItem('events') || '[]');
    const filtered = events.filter(e => e.id !== eventId && e.tempId !== eventId);
        localStorage.setItem('events', JSON.stringify(filtered));
        
        // Clear current event if it was the deleted one
        if (currentEvent === eventId) {
            currentEvent = null;
            selector.value = '';
            
            // Clear buy sheet
            currentBuySheet = createEmptyBuySheet();
            renderBuySheet();
            saveBuySheet();
        }
    
    // Try to delete from database (or queue if offline)
    try {
        // Only queue if it has a real ID (not temp)
        if (eventId && !eventId.startsWith('temp-')) {
            await executeOrQueue({
                type: 'deleteEvent',
                data: { eventId: eventId }
            });
        }
    } catch (error) {
        console.error('Error deleting event from database (queued for sync):', error);
        }
        
        // Reload events dropdown
        await loadEvents();
        
        // Refresh all displays
        renderBuyList();
        renderSales();
        renderExpenses();
        recalculatePL();
        updateDashboard();
        
    alert(`Event "${event.name}" has been deleted${!isOnline ? ' (will sync when online)' : ''}.`);
}

// Clear all events (both main events and planned events)
async function clearAllEvents() {
    const confirmMessage = `Are you sure you want to delete ALL events?\n\nThis will permanently delete:\n- All main events (buy lists, sales, expenses, P/L data)\n- All planned events from Event Planner\n\nThis action CANNOT be undone!`;
    
    if (!confirm(confirmMessage)) {
        return;
    }
    
    // Double confirmation
    if (!confirm('This will delete EVERYTHING. Are you absolutely sure?')) {
        return;
    }
    try {
        // Get all events from cache or load from database
        let eventsToDelete = eventsCache.length > 0 ? eventsCache : await loadEventsFromDB();
        
        // Get all planned events from cache or load from database
        let plannedEventsToDelete = plannedEventsCache.length > 0 ? plannedEventsCache : await loadPlannedEventsFromDB();
        
        // Delete all main events from Supabase
        const userId = getUserId();
        if (eventsToDelete.length > 0) {
            // Delete all events for this user from Supabase
            const { error: eventsError } = await supabase
                .from('events')
                .delete()
                .eq('user_id', userId);
            
            if (eventsError) {
                console.error('Error deleting events from database:', eventsError);
                // Fallback: try deleting one by one
                for (const event of eventsToDelete) {
                    if (event.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(event.id)) {
                        try {
                            await deleteEventFromDB(event.id);
                        } catch (err) {
                            console.error(`Error deleting event ${event.id}:`, err);
                        }
                    }
                }
            }
        }
        
        // Delete all planned events from Supabase
        if (plannedEventsToDelete.length > 0) {
            // Delete all planned events for this user from Supabase
            const { error: plannedError } = await supabase
                .from('planned_events')
                .delete()
                .eq('user_id', userId);
            
            if (plannedError) {
                console.error('Error deleting planned events from database:', plannedError);
                // Fallback: try deleting one by one
                for (const event of plannedEventsToDelete) {
                    if (event.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(event.id)) {
                        try {
                            await deletePlannedEventFromDB(event.id);
                        } catch (err) {
                            console.error(`Error deleting planned event ${event.id}:`, err);
                        }
                    }
                }
            }
        }
        
        // Clear main events cache and localStorage
        eventsCache = [];
    localStorage.setItem('events', JSON.stringify([]));
    
        // Clear planned events cache and localStorage
        plannedEventsCache = [];
    localStorage.setItem('plannedEvents', JSON.stringify([]));
    
    // Clear current event
    currentEvent = null;
        const selector = document.getElementById('event-selector');
        if (selector) selector.value = '';
    
    // Clear buy sheet
    currentBuySheet = createEmptyBuySheet();
    
    // Reload everything
        await loadEvents();
    loadEventList();
    renderBuySheet();
    saveBuySheet();
    renderBuyList();
    renderSales();
    renderExpenses();
    recalculatePL();
    updateDashboard();
    
    alert('All events have been deleted successfully.');
    } catch (error) {
        console.error('Error clearing all events:', error);
        alert('Error deleting events: ' + (error.message || 'Unknown error. Please check the console.'));
    }
}

// Make functions globally accessible
window.deleteMainEvent = deleteMainEvent;
window.clearAllEvents = clearAllEvents;

function getEvent(eventId) {
    // Use cached events from Supabase
    const events = eventsCache.length > 0 ? eventsCache : JSON.parse(localStorage.getItem('events') || '[]');
    return events.find(e => e.id === eventId || e.tempId === eventId);
}

async function saveEvent(event) {
    // Always save to localStorage first (for offline mode)
    const events = JSON.parse(localStorage.getItem('events') || '[]');
    const localIndex = events.findIndex(e => e.id === event.id || (e.tempId && e.tempId === event.tempId));
    
    // Generate temp ID if needed for offline tracking
    if (!event.id && !event.tempId) {
        event.tempId = 'temp-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    }
    
    if (localIndex !== -1) {
        events[localIndex] = event;
    } else {
        events.push(event);
    }
    localStorage.setItem('events', JSON.stringify(events));
        
        // Update cache
    const index = eventsCache.findIndex(e => e.id === event.id || (e.tempId && e.tempId === event.tempId));
        if (index !== -1) {
            eventsCache[index] = event;
        } else {
            eventsCache.push(event);
        }
        
    // Try to save to database (or queue if offline)
    try {
        await executeOrQueue({
            type: 'saveEvent',
            data: {
                event: event,
                buyList: event.buyList || [],
                sales: event.sales || [],
                expenses: event.expenses || []
            }
        });
        
        // If we got an ID from DB, update it
        if (event.id && !event.id.startsWith('temp-')) {
            const updatedIndex = events.findIndex(e => (e.tempId && e.tempId === event.tempId) || e.id === event.id);
            if (updatedIndex !== -1) {
                events[updatedIndex] = event;
            localStorage.setItem('events', JSON.stringify(events));
        }
        }
    } catch (error) {
        console.error('Error saving event to database (queued for sync):', error);
        // Event is already in localStorage, will sync when online
    }
}

function saveBuySheet() {
    ensureBuySheet();
    // Update buy sheet with form values before saving
    const customerField = document.getElementById('buy-sheet-customer');
    const previousCustomer = currentBuySheet.customer || '';
    const hadContactInfo = Object.values(currentBuySheet.contact || {}).some(value => value && value.trim() !== '');
    const newCustomer = customerField ? customerField.value.trim() : '';
    const customerChanged = previousCustomer !== newCustomer;

    if (customerField) {
        currentBuySheet.customer = newCustomer;
    }

    if (customerChanged && hadContactInfo) {
        currentBuySheet.contact = {
            phone: '',
            email: '',
            address: '',
            city: '',
            state: '',
            zip: ''
        };
        Object.values(BUY_SHEET_CONTACT_FIELDS).forEach(elementId => {
            const field = document.getElementById(elementId);
            if (field) {
                field.value = '';
            }
        });
    }

    const notesField = document.getElementById('buy-sheet-notes');
    if (notesField) {
        currentBuySheet.notes = notesField.value;
    }

    currentBuySheet.contact = currentBuySheet.contact || {};
    Object.entries(BUY_SHEET_CONTACT_FIELDS).forEach(([key, elementId]) => {
        const input = document.getElementById(elementId);
        if (input) {
            currentBuySheet.contact[key] = input.value;
        }
    });

    const contactPrefilled = prefillBuySheetContactFromCustomer();

    persistCurrentBuySheetState();
    if (contactPrefilled || (customerChanged && hadContactInfo)) {
        syncBuySheetContactInputs();
    }
}
function loadBuySheet() {
    if (currentEvent) {
        const saved = localStorage.getItem(`buySheet_${currentEvent}`);
        if (saved) {
            currentBuySheet = JSON.parse(saved);
            ensureBuySheet();
        } else {
            // Reset buy sheet for new event
            currentBuySheet = createEmptyBuySheet();
        }
        ensureBuySheet();
        renderBuySheet();
    } else {
        // Reset buy sheet when no event selected
        currentBuySheet = createEmptyBuySheet();
        renderBuySheet();
    }
}

// Utility Functions
function formatCurrency(amount) {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD'
    }).format(amount || 0);
}

function setDefaultDate() {
    const today = new Date().toISOString().split('T')[0];
    document.querySelectorAll('input[type="date"]').forEach(input => {
        if (!input.value) {
            input.value = today;
        }
    });
}

function closeModals() {
    document.querySelectorAll('.modal').forEach(modal => {
        modal.style.display = 'none';
        modal.classList.remove('active');
    });
    // Also close the confirm transaction modal
    closeConfirmTransactionModal();
}

function closeCustomerProfile() {
    const modal = document.getElementById('customer-profile-modal');
    if (modal) {
        modal.style.display = 'none';
    }
}

function closeBuySheetDetail() {
    const modal = document.getElementById('buy-sheet-detail-modal');
    if (modal) {
        modal.style.display = 'none';
    }
}
function openBuySheetDetail(index, customerName) {
    if (!window.currentCustomerBuySheets || !window.currentCustomerBuySheets[index]) {
        alert('Buy sheet not found');
        return;
    }
    
    const sheet = window.currentCustomerBuySheets[index];
    const detailContent = document.getElementById('buy-sheet-detail-content');
    const detailTitle = document.getElementById('buy-sheet-detail-title');
    
    if (!detailContent || !detailTitle) {
        alert('Buy sheet detail modal not found');
        return;
    }
    
    const sheetNumber = window.currentCustomerBuySheets.length - index;
    detailTitle.textContent = `Buy Sheet #${sheetNumber}`;
    
    // Build items list HTML if there are multiple items
    let itemsListHTML = '';
    if (sheet.items && sheet.items.length > 1) {
        const totalWeight = sheet.items.reduce((sum, item) => sum + (item.weight || 0), 0);
        const totalMelt = sheet.items.reduce((sum, item) => sum + (item.fullMelt || 0), 0);
        const totalOffer = sheet.items.reduce((sum, item) => sum + (item.offer || 0), 0);
        
        itemsListHTML = `
            <div class="buy-sheet-detail-card">
                <div class="buy-sheet-detail-card-header">
                    <h3 class="detail-section-title">
                        <span class="detail-icon">📦</span>
                        Items Purchased (${sheet.items.length})
                    </h3>
                </div>
                <div class="buy-sheet-detail-card-body">
                    <div class="items-table-container">
                        <table class="buy-sheet-items-table">
                            <thead>
                                <tr>
                                    <th>Category</th>
                                    <th>Description</th>
                                    <th>Weight</th>
                                    <th>Melt Value</th>
                                    <th>Offer</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${sheet.items.map((item, idx) => `
                                    <tr class="item-row ${idx % 2 === 0 ? 'even' : 'odd'}">
                                        <td>
                                            <span class="item-category-badge">${item.category || '-'}</span>
                                        </td>
                                        <td>
                                            <div class="item-description">
                                                <strong>${item.description || '-'}</strong>
                                                ${item.metal && item.karat && item.metal !== 'N/A' ? `
                                                    <div class="item-metal-info">
                                                        ${item.metal} ${item.karat}K
                                                    </div>
                                                ` : ''}
                                            </div>
                                        </td>
                                        <td class="text-right">
                                            ${item.weight ? item.weight.toFixed(2) + 'g' : '-'}
                                        </td>
                                        <td class="text-right">
                                            ${item.fullMelt ? formatCurrency(item.fullMelt) : '-'}
                                        </td>
                                        <td class="text-right">
                                            <strong class="offer-amount">${formatCurrency(item.offer || 0)}</strong>
                                        </td>
                                    </tr>
                                `).join('')}
                            </tbody>
                            <tfoot>
                                <tr class="items-total-row">
                                    <td colspan="2"><strong>Total:</strong></td>
                                    <td class="text-right"><strong>${totalWeight.toFixed(2)}g</strong></td>
                                    <td class="text-right"><strong>${formatCurrency(totalMelt)}</strong></td>
                                    <td class="text-right"><strong class="offer-amount">${formatCurrency(totalOffer)}</strong></td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                </div>
            </div>
        `;
    }
    
    // Format date nicely
    const formattedDate = new Date(sheet.date).toLocaleDateString('en-US', { 
        weekday: 'long', 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
    });
    const shortDate = new Date(sheet.date).toLocaleDateString('en-US', { 
        month: 'short', 
        day: 'numeric', 
        year: 'numeric' 
    });
    detailContent.innerHTML = `
        <div class="buy-sheet-detail-container">
            <!-- Hero Header -->
            <div class="buy-sheet-detail-hero">
                <div class="buy-sheet-detail-hero-left">
                    <div class="buy-sheet-detail-hero-number">
                        <span class="hero-number-label">Buy Sheet</span>
                        <span class="hero-number-value">#${sheetNumber}</span>
                </div>
                    <div class="buy-sheet-detail-hero-date">
                        <span class="hero-date-icon">📅</span>
                        <div>
                            <div class="hero-date-main">${formattedDate}</div>
                            <div class="hero-date-sub">${shortDate}</div>
                        </div>
                    </div>
                </div>
                <div class="buy-sheet-detail-hero-right">
                    <div class="buy-sheet-detail-hero-amount">
                        <span class="hero-amount-label">Total Amount Paid</span>
                        <span class="hero-amount-value">${formatCurrency(sheet.amount)}</span>
                    </div>
                </div>
            </div>
            
            <!-- Quick Info Cards -->
            <div class="buy-sheet-quick-info">
                <div class="quick-info-card">
                    <div class="quick-info-icon">🏷️</div>
                    <div class="quick-info-content">
                        <div class="quick-info-label">Category</div>
                        <div class="quick-info-value">${sheet.category || 'N/A'}</div>
                </div>
                        </div>
                <div class="quick-info-card">
                    <div class="quick-info-icon">📦</div>
                    <div class="quick-info-content">
                        <div class="quick-info-label">Items</div>
                        <div class="quick-info-value">${sheet.items ? sheet.items.length : 1}</div>
                        </div>
                        </div>
                <div class="quick-info-card">
                    <div class="quick-info-icon">📍</div>
                    <div class="quick-info-content">
                        <div class="quick-info-label">Event</div>
                        <div class="quick-info-value">${sheet.eventName || 'N/A'}</div>
                        </div>
                        </div>
                        ${sheet.checkNumber ? `
                <div class="quick-info-card highlight">
                    <div class="quick-info-icon">🔖</div>
                    <div class="quick-info-content">
                        <div class="quick-info-label">Check Number</div>
                        <div class="quick-info-value">#${sheet.checkNumber}</div>
                    </div>
                        </div>
                        ` : ''}
            </div>
            
            ${itemsListHTML}
            
            ${sheet.items && sheet.items.length === 1 && sheet.items[0].metal !== 'N/A' && sheet.items[0].karat !== 'N/A' ? `
            <!-- Metal Information Card -->
            <div class="buy-sheet-detail-card">
                <div class="buy-sheet-detail-card-header">
                    <h3 class="detail-section-title">
                        <span class="detail-icon">💎</span>
                        Metal Information
                    </h3>
                </div>
                <div class="buy-sheet-detail-card-body">
                    <div class="detail-info-grid">
                        <div class="detail-info-item">
                            <label>Metal Type</label>
                            <div class="detail-info-value">
                                <span class="metal-badge metal-${(sheet.items[0].metal || '').toLowerCase()}">${sheet.items[0].metal}</span>
                            </div>
                        </div>
                        <div class="detail-info-item">
                            <label>Karat/Purity</label>
                            <div class="detail-info-value">
                                <span class="karat-badge">${sheet.items[0].karat}K</span>
                            </div>
                        </div>
                        <div class="detail-info-item">
                            <label>Weight</label>
                            <div class="detail-info-value weight-display">${sheet.items[0].weight ? sheet.items[0].weight.toFixed(2) + 'g' : '-'}</div>
                        </div>
                        ${sheet.items[0].fullMelt > 0 ? `
                        <div class="detail-info-item highlight-item">
                            <label>Melt Value</label>
                            <div class="detail-info-value highlight">${formatCurrency(sheet.items[0].fullMelt)}</div>
                        </div>
                        ` : ''}
                        ${sheet.items[0].offer > 0 ? `
                        <div class="detail-info-item highlight-item">
                            <label>Offer Amount</label>
                            <div class="detail-info-value highlight offer-highlight">${formatCurrency(sheet.items[0].offer)}</div>
                        </div>
                        ` : ''}
                    </div>
                </div>
            </div>
            ` : ''}
            
            ${sheet.items && sheet.items.length === 1 && sheet.items[0].description && sheet.items[0].description !== 'N/A' ? `
            <!-- Description Card -->
            <div class="buy-sheet-detail-card">
                <div class="buy-sheet-detail-card-header">
                    <h3 class="detail-section-title">
                        <span class="detail-icon">📝</span>
                        Description
                    </h3>
                </div>
                <div class="buy-sheet-detail-card-body">
                    <div class="detail-info-value description-text">${sheet.items[0].description}</div>
                </div>
            </div>
            ` : ''}
            
            ${sheet.notes ? `
            <!-- Notes Card -->
            <div class="buy-sheet-detail-card">
                <div class="buy-sheet-detail-card-header">
                    <h3 class="detail-section-title">
                        <span class="detail-icon">📌</span>
                        Notes
                    </h3>
                </div>
                <div class="buy-sheet-detail-card-body">
                    <div class="detail-info-value notes-text">${sheet.notes}</div>
                </div>
            </div>
            ` : ''}
        </div>
    `;
    
    // Open modal - center it
    const modal = document.getElementById('buy-sheet-detail-modal');
    modal.style.display = 'flex';
    modal.style.alignItems = 'center';
    modal.style.justifyContent = 'center';
}

// Customer Management Functions (globally accessible)
function deleteCustomerConfirm(customerName) {
    console.log('deleteCustomerConfirm called with:', customerName);
    
    if (!customerName) {
        console.error('deleteCustomerConfirm called with no customer name');
        alert('Error: No customer name provided');
        return false;
    }
    
    // Decode the customer name in case it has special characters
    try {
        customerName = decodeURIComponent(customerName);
    } catch (e) {
        // If decoding fails, use the original name
    }
    
    console.log('Deleting customer:', customerName);
    const result = deleteCustomer(customerName);
    
    if (!result) {
        console.log('Customer deletion was cancelled or failed');
    }
    
    return false; // Prevent any further event handling
}
// Make functions globally accessible
window.openBuySheetDetail = openBuySheetDetail;
window.closeConfirmTransactionModal = closeConfirmTransactionModal;
window.proceedWithConfirmation = proceedWithConfirmation;

// ================================
// CRM Management (Management Tab)
// ================================
const crmState = {
    customers: [],
    map: new Map(),
    selectedCustomer: null,
    pendingSelection: null,
    searchQuery: '',
    needsRefresh: false
};

function buildCRMManagementData() {
    const customersData = getCustomersData();
    let events = Array.isArray(eventsCache) && eventsCache.length > 0
        ? eventsCache
        : JSON.parse(localStorage.getItem('events') || '[]');
    if (!Array.isArray(events)) events = [];

    const customersMap = new Map();
    let totalBuySheets = 0;

    const registerCustomer = (name, item) => {
        const normalized = name.trim();
        if (!normalized) return null;

        if (!customersMap.has(normalized)) {
            const storedInfo = customersData[normalized] || {};
            customersMap.set(normalized, {
                name: normalized,
                contact: {
                    phone: storedInfo.phone || item?.customerPhone || '',
                    email: storedInfo.email || item?.customerEmail || '',
                    address: storedInfo.address || item?.customerAddress || '',
                    city: storedInfo.city || item?.customerCity || '',
                    state: storedInfo.state || item?.customerState || '',
                    zip: storedInfo.zip || item?.customerZip || ''
                },
                totalPaid: 0,
                totalWeight: 0,
                transactions: 0,
                lastTransaction: null,
                buySheetsMap: new Map()
            });
        }

        const customer = customersMap.get(normalized);
        if (item) {
            customer.contact.phone = customer.contact.phone || item.customerPhone || '';
            customer.contact.email = customer.contact.email || item.customerEmail || '';
            customer.contact.address = customer.contact.address || item.customerAddress || '';
            customer.contact.city = customer.contact.city || item.customerCity || '';
            customer.contact.state = customer.contact.state || item.customerState || '';
            customer.contact.zip = customer.contact.zip || item.customerZip || '';
        }
        return customer;
    };

    events.forEach(event => {
        const buyList = Array.isArray(event?.buyList) ? event.buyList : [];
        buyList.forEach(item => {
            if (!item || !item.customer) return;

            const names = item.customer.split(',').map(c => c.trim()).filter(Boolean);
            names.forEach(name => {
                const customer = registerCustomer(name, item);
                if (!customer) return;

                const offer = Number(item.offer) || 0;
                const weight = Number(item.weight) || 0;
                const date = item.datePurchased || event.date || event.created || new Date().toISOString().split('T')[0];
                const sheetIdRaw = item.buySheetId || (Array.isArray(item.buySheetIds) && item.buySheetIds[0]) || null;
                const sheetKey = sheetIdRaw ? String(sheetIdRaw) : `${event.id || event.tempId || 'event'}_${date}_${customer.name}`;

                let sheet = customer.buySheetsMap.get(sheetKey);
                if (!sheet) {
                    sheet = {
                        id: sheetKey,
                        sheetId: sheetIdRaw ? String(sheetIdRaw) : null,
                        eventId: event.id || event.tempId || null,
                        eventName: event.name || 'Untitled Event',
                        date,
                        checkNumber: item.checkNumber || null,
                        totalOffer: 0,
                        items: []
                    };
                    customer.buySheetsMap.set(sheetKey, sheet);
                    totalBuySheets += 1;
                }

                sheet.totalOffer += offer;
                sheet.checkNumber = sheet.checkNumber || item.checkNumber || null;
                sheet.items.push({
                    category: item.category || '',
                    description: item.description || '',
                    offer,
                    weight,
                    metal: item.metal || '',
                    karat: item.karat || '',
                    date
                });

                customer.totalPaid += offer;
                customer.totalWeight += weight;
                customer.transactions += 1;

                if (!customer.lastTransaction || date > customer.lastTransaction) {
                    customer.lastTransaction = date;
                }
            });
        });
    });

    const customersList = Array.from(customersMap.values()).map(customer => {
        const buySheets = Array.from(customer.buySheetsMap.values())
            .sort((a, b) => {
                const dateA = a.date || '';
                const dateB = b.date || '';
                return dateA < dateB ? 1 : dateA > dateB ? -1 : 0;
            });

        return {
            name: customer.name,
            contact: customer.contact,
            totalPaid: customer.totalPaid,
            totalWeight: customer.totalWeight,
            transactions: customer.transactions,
            lastTransaction: customer.lastTransaction,
            buySheets,
            buySheetsCount: buySheets.length
        };
    }).sort((a, b) => {
        if (b.totalPaid !== a.totalPaid) {
            return b.totalPaid - a.totalPaid;
        }
        if (b.lastTransaction && a.lastTransaction) {
            return b.lastTransaction.localeCompare(a.lastTransaction);
        }
        return a.name.localeCompare(b.name);
    });

    const summary = customersList.reduce((acc, customer) => {
        acc.totalPaid += customer.totalPaid;
        if (!acc.mostRecent || (customer.lastTransaction && customer.lastTransaction > acc.mostRecent)) {
            acc.mostRecent = customer.lastTransaction;
        }
        return acc;
    }, { totalPaid: 0, mostRecent: null });

    summary.totalCustomers = customersList.length;
    summary.totalBuySheets = totalBuySheets;
    summary.avgCustomerValue = summary.totalCustomers ? summary.totalPaid / summary.totalCustomers : 0;

    const map = new Map(customersList.map(customer => [customer.name, customer]));

    return { list: customersList, summary, map };
}

function renderCRMManagement() {
    const crmSection = document.getElementById('crm-management');
    if (!crmSection) return;

    const customersTableBody = document.getElementById('crm-customers-tbody');
    const totalCustomersEl = document.getElementById('crm-total-customers');
    const totalPaidEl = document.getElementById('crm-total-paid');
    const averageValueEl = document.getElementById('crm-average-value');
    const mostRecentEl = document.getElementById('crm-most-recent');
    const visibleCountEl = document.getElementById('crm-visible-count');

    const { list, summary, map } = buildCRMManagementData();

    const query = crmState.searchQuery.trim().toLowerCase();
    const filteredList = query
        ? list.filter(customer => {
            const nameMatch = customer.name.toLowerCase().includes(query);
            const phoneMatch = (customer.contact.phone || '').toLowerCase().includes(query);
            const emailMatch = (customer.contact.email || '').toLowerCase().includes(query);
            return nameMatch || phoneMatch || emailMatch;
        })
        : list;

    crmState.customers = filteredList;
    crmState.map = map;

    const desiredSelection = crmState.pendingSelection || crmState.selectedCustomer;
    crmState.pendingSelection = null;

    if (!desiredSelection || !map.has(desiredSelection)) {
        crmState.selectedCustomer = filteredList.length > 0 ? filteredList[0].name : null;
    } else {
        crmState.selectedCustomer = desiredSelection;
    }

    if (totalCustomersEl) totalCustomersEl.textContent = summary.totalCustomers;
    if (totalPaidEl) totalPaidEl.textContent = formatCurrency(summary.totalPaid);
    if (averageValueEl) averageValueEl.textContent = formatCurrency(summary.avgCustomerValue);
    if (mostRecentEl) {
        mostRecentEl.textContent = summary.mostRecent
            ? formatDateForDisplay(summary.mostRecent)
            : '—';
    }
    if (visibleCountEl) {
        visibleCountEl.textContent = `${filteredList.length} visible`;
    }

    if (customersTableBody) {
        if (filteredList.length === 0) {
            customersTableBody.innerHTML = `
                <tr>
                    <td colspan="5" class="empty-message">No customers yet.</td>
                </tr>
            `;
        } else {
            customersTableBody.innerHTML = filteredList.map(customer => `
                <tr data-customer="${customer.name}" class="${customer.name === crmState.selectedCustomer ? 'active-row' : ''}">
                    <td>
                        <strong>${escapeHtml(customer.name)}</strong>
                        ${customer.contact.phone ? `<div style="color: var(--text-muted); font-size: 0.85rem;">${escapeHtml(customer.contact.phone)}</div>` : ''}
                    </td>
                    <td>${formatCurrency(customer.totalPaid)}</td>
                    <td>${customer.lastTransaction ? formatDateForDisplay(customer.lastTransaction) : '—'}</td>
                    <td>${customer.buySheetsCount}</td>
                    <td style="text-align: right;">
                        <button class="btn-secondary btn-sm" data-customer="${customer.name}">View</button>
                    </td>
                </tr>
            `).join('');
        }
    }

    renderCRMCustomerDetail(crmState.selectedCustomer ? map.get(crmState.selectedCustomer) : null);
    highlightCRMSelectedRow();
    crmState.needsRefresh = false;
}

function renderCRMCustomerDetail(customer) {
    const panel = document.getElementById('crm-detail-panel');
    if (!panel) return;

    if (!customer) {
        panel.innerHTML = `
            <div class="crm-detail-empty" style="text-align: center; color: var(--text-muted);">
                <h3 style="margin-bottom: 0.5rem;">Select a customer</h3>
                <p style="margin: 0;">Choose a customer to view contact details and buy sheet history.</p>
            </div>
        `;
        return;
    }

    const contactRows = [
        { label: 'Phone', value: customer.contact.phone || '—' },
        { label: 'Email', value: customer.contact.email || '—' },
        {
            label: 'Address',
            value: customer.contact.address
                ? [customer.contact.address, customer.contact.city, customer.contact.state, customer.contact.zip].filter(Boolean).join(', ')
                : '—'
        }
    ];

    const buySheetsHTML = customer.buySheets.length > 0
        ? customer.buySheets.map(sheet => `
            <div class="crm-sheet-card" style="border: 1px solid #e5e7eb; border-radius: 10px; padding: 1rem; margin-bottom: 1rem;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem;">
                    <div>
                        <strong>${formatDateForDisplay(sheet.date)}</strong>
                        <div style="color: var(--text-muted); font-size: 0.85rem;">${escapeHtml(sheet.eventName)}</div>
                    </div>
                    <div style="text-align: right;">
                        <div style="font-weight: 600;">${formatCurrency(sheet.totalOffer)}</div>
                        ${sheet.checkNumber ? `<div style="color: var(--text-muted); font-size: 0.85rem;">Check #${escapeHtml(sheet.checkNumber)}</div>` : ''}
                    </div>
                </div>
                <div class="table-container">
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th>Item</th>
                                <th>Offer</th>
                                <th>Weight</th>
                                <th>Metal</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${sheet.items.map(item => `
                                <tr>
                                    <td>${escapeHtml(item.description || item.category || 'Item')}</td>
                                    <td>${formatCurrency(item.offer || 0)}</td>
                                    <td>${item.weight ? `${Number(item.weight).toFixed(2)}g` : '—'}</td>
                                    <td>${item.metal ? `${escapeHtml(item.metal)}${item.karat ? ` ${escapeHtml(String(item.karat))}K` : ''}` : '—'}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        `).join('')
        : '<div class="empty-message">No buy sheets recorded yet.</div>';

    panel.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; margin-bottom: 1rem;">
            <div>
                <h3 style="margin: 0;">${escapeHtml(customer.name)}</h3>
                <div style="color: var(--text-muted); font-size: 0.9rem;">
                    Last transaction: ${customer.lastTransaction ? formatDateForDisplay(customer.lastTransaction) : '—'}
                </div>
            </div>
            <div style="text-align: right;">
                <div style="font-size: 1.25rem; font-weight: 600;">${formatCurrency(customer.totalPaid)}</div>
                <div style="color: var(--text-muted); font-size: 0.85rem;">Total Paid</div>
            </div>
        </div>

        <div class="crm-detail-section" style="margin-bottom: 1.5rem;">
            <h4 style="margin-bottom: 0.75rem;">Contact Information</h4>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 0.75rem;">
                ${contactRows.map(row => `
                    <div style="padding: 0.75rem; background: #f8fafc; border-radius: 8px;">
                        <div style="color: var(--text-muted); font-size: 0.75rem; text-transform: uppercase;">${row.label}</div>
                        <div style="font-weight: 600;">${escapeHtml(row.value)}</div>
                    </div>
                `).join('')}
            </div>
        </div>

        <div class="crm-detail-section">
            <h4 style="margin-bottom: 0.75rem;">Buy Sheets (${customer.buySheetsCount})</h4>
            ${buySheetsHTML}
        </div>
    `;
}

function highlightCRMSelectedRow() {
    const rows = document.querySelectorAll('#crm-customers-tbody tr[data-customer]');
    rows.forEach(row => {
        const isSelected = row.dataset.customer === crmState.selectedCustomer;
        row.classList.toggle('active-row', isSelected);
        if (isSelected) {
            row.style.backgroundColor = 'rgba(212, 175, 55, 0.12)';
        } else {
            row.style.backgroundColor = '';
        }
    });
}

function handleCRMRowClick(event) {
    const row = event.target.closest('tr[data-customer]');
    if (!row) return;
    const customerName = row.dataset.customer;
    if (!customerName) return;

    crmState.selectedCustomer = customerName;
    highlightCRMSelectedRow();
    const customer = crmState.map.get(customerName);
    renderCRMCustomerDetail(customer || null);
}

function refreshCRMIfActive(preferredCustomer = null) {
    if (preferredCustomer) {
        crmState.pendingSelection = preferredCustomer;
    }

    const crmSection = document.getElementById('crm-management');
    if (crmSection && crmSection.classList.contains('active')) {
        renderCRMManagement();
    } else {
        crmState.needsRefresh = true;
    }
}

function navigateToCRM(customerName) {
    crmState.pendingSelection = customerName || null;
    crmState.searchQuery = '';
    const searchInput = document.getElementById('crm-search-input');
    if (searchInput) {
        searchInput.value = '';
    }
    switchTab('crm-management');
}

openCustomerProfile = function(customerName) {
    navigateToCRM(customerName || '');
    return false;
};

viewCustomerFromCheck = function(customerName) {
    navigateToCRM(customerName || '');
};

renderCustomers = () => {};
searchCustomers = () => {};
clearCustomerSearch = () => {};
showCustomerAutocomplete = () => {};
hideCustomerAutocomplete = () => {};
showCustomerSearchAutocomplete = () => {};
hideCustomerSearchAutocomplete = () => {};
openManageRefineriesModal = () => {};
renderRefineryList = () => {};
addRefinery = () => {};
removeRefinery = () => {};
closeCustomerProfile = () => {};
deleteCustomerConfirm = () => {
    alert('Customer deletion is currently disabled in this CRM view.');
    return false;
};

function openNewEventModal() {
    document.getElementById('new-event-modal').classList.add('active');
}

// Export Report
function exportReport() {
    if (!currentEvent) {
        alert('Please select an event first');
        return;
    }

    const event = getEvent(currentEvent);
    const buyList = event.buyList || [];
    const sales = event.sales || [];
    const expenses = event.expenses || [];

    recalculatePL();

    // Calculate totals using the same logic as recalculatePL
    const totalOffer = buyList.reduce((sum, item) => sum + (item.offer || 0), 0); // Total spent on buying items
    const totalRevenue = sales.reduce((sum, sale) => sum + (sale.totalRevenue || sale.totalPrice || 0), 0);
    
    // Calculate total purchase cost from sales (cost of items actually sold)
    let totalPurchaseCost = 0;
    sales.forEach(sale => {
        if (sale.purchaseCost !== undefined && sale.purchaseCost !== null) {
            totalPurchaseCost += sale.purchaseCost;
        } else if (sale.buyListIndex !== undefined && sale.buyListIndex !== null) {
            // Fallback: calculate from buy list item
            const buyItem = buyList[sale.buyListIndex];
            if (buyItem) {
                if (buyItem.isNonMetal) {
                    totalPurchaseCost += buyItem.offer || 0;
                } else {
                    // For metal items, calculate based on weight sold
                    const weightSold = sale.weightSold || buyItem.weight;
                    const costPerGram = (buyItem.offer || 0) / (buyItem.weight || 1);
                    totalPurchaseCost += weightSold * costPerGram;
                }
            }
        }
    });
    
    const totalExpenses = expenses.reduce((sum, exp) => sum + (exp.amount || 0), 0);
    
    // Net Profit = Total Revenue - Total Purchase Cost (of sold items) - Total Expenses
    // Only subtract the cost of items that were actually sold, not all purchases
    const netProfit = totalRevenue - totalPurchaseCost - totalExpenses;

    const report = `
<!DOCTYPE html>
<html>
<head>
    <title>P/L Report - ${event.name}</title>
    <style>
        body { font-family: Arial, sans-serif; padding: 2rem; }
        h1 { color: #d4af37; }
        table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
        th, td { padding: 0.5rem; border: 1px solid #ddd; text-align: left; }
        th { background-color: #f8f9fa; }
        .summary { margin-top: 2rem; padding: 1rem; background: #f9f9f9; }
        .highlight { font-size: 1.2rem; font-weight: bold; color: #d4af37; }
    </style>
</head>
<body>
    <h1>Profit & Loss Report</h1>
    <h2>${event.name}</h2>
    <p>Date: ${event.created}</p>
    
    <h3>A. Purchases</h3>
    <table>
        <tr>
            <th>Category</th><th>Metal</th><th>Weight</th><th>Melt Value</th><th>Offer</th><th>Profit</th>
        </tr>
        ${buyList.map(item => `
            <tr>
                <td>${item.category || '-'}</td>
                <td>${item.metal || '-'}</td>
                <td>${item.weight ? item.weight.toFixed(2) + 'g' : '-'}</td>
                <td>${item.fullMelt ? formatCurrency(item.fullMelt) : '-'}</td>
                <td>${item.offer ? formatCurrency(item.offer) : '$0.00'}</td>
                <td>${formatCurrency(item.profit || 0)}</td>
            </tr>
        `).join('')}
        <tr>
            <td colspan="3"><strong>Totals:</strong></td>
            <td><strong>${formatCurrency(buyList.reduce((sum, item) => sum + (item.fullMelt || 0), 0))}</strong></td>
            <td><strong>${formatCurrency(totalOffer)}</strong></td>
            <td><strong>${formatCurrency(buyList.reduce((sum, item) => sum + (item.profit || 0), 0))}</strong></td>
        </tr>
    </table>

    <h3>B. Sales</h3>
    <table>
        <tr>
            <th>Metal</th><th>Weight</th><th>Revenue</th><th>Cost</th><th>Profit</th>
        </tr>
        ${sales.map(sale => {
            const saleRevenue = sale.totalRevenue || sale.totalPrice || 0;
            const saleCost = sale.purchaseCost || 0;
            const saleProfit = sale.profit || (saleRevenue - saleCost);
            return `
            <tr>
                <td>${sale.metal || sale.category || '-'}</td>
                <td>${sale.weightSold ? sale.weightSold.toFixed(2) + 'g' : '-'}</td>
                <td>${formatCurrency(saleRevenue)}</td>
                <td>${formatCurrency(saleCost)}</td>
                <td>${formatCurrency(saleProfit)}</td>
            </tr>
            `;
        }).join('')}
        <tr>
            <td colspan="2"><strong>Totals:</strong></td>
            <td><strong>${formatCurrency(totalRevenue)}</strong></td>
            <td><strong>${formatCurrency(totalPurchaseCost)}</strong></td>
            <td><strong>${formatCurrency(totalRevenue - totalPurchaseCost)}</strong></td>
        </tr>
    </table>

    <h3>C. Expenses</h3>
    <table>
        <tr>
            <th>Category</th><th>Description</th><th>Amount</th>
        </tr>
        ${expenses.map(exp => `
            <tr>
                <td>${exp.category}</td>
                <td>${exp.description}</td>
                <td>${formatCurrency(exp.amount)}</td>
            </tr>
        `).join('')}
        <tr>
            <td colspan="2"><strong>Total Expenses:</strong></td>
            <td><strong>${formatCurrency(totalExpenses)}</strong></td>
        </tr>
    </table>

    <div class="summary">
        <h3>D. Summary</h3>
        <p><strong>Purchase of Goods (Total Offer):</strong> ${formatCurrency(totalOffer)}</p>
        <p><strong>Total Revenue (Sales):</strong> ${formatCurrency(totalRevenue)}</p>
        <p><strong>Purchase Cost (Cost of Sold Items):</strong> ${formatCurrency(totalPurchaseCost)}</p>
        <p><strong>Total Expenses:</strong> ${formatCurrency(totalExpenses)}</p>
        <p class="highlight"><strong>Net Profit:</strong> ${formatCurrency(netProfit)}</p>
        <p style="margin-top: 1rem; font-size: 0.9rem; color: #666;">Net Profit = Total Revenue - Purchase Cost (of sold items) - Total Expenses</p>
    </div>
</body>
</html>
    `;

    const blob = new Blob([report], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${event.name}_PL_Report.html`;
    a.click();
    URL.revokeObjectURL(url);
}

// ============================================
// EVENT PLANNING & MARKET RESEARCH
// ============================================

// U.S. Census API Configuration
const CENSUS_API_KEY = '0a684293b9e4a029209007061faf62cc12bcbdf2';
const CENSUS_BASE_URL = 'https://api.census.gov/data/2021/acs/acs5';
// Google Places API Configuration
const GOOGLE_PLACES_API_KEY = 'AIzaSyDIMPxM58NLfUnIUvsHDXFxQGYS6Tx2_XQ';
const GOOGLE_PLACES_BASE_URL = 'https://maps.googleapis.com/maps/api/place/textsearch/json';

// Store current research data for use in Event Planner
let currentResearchData = null;
let currentSearchType = 'city'; // 'city' or 'zip'

// Census API Variables Reference:
// B01001_001E - Total Population
// B19013_001E - Median Household Income
// B25077_001E - Median Home Value
// B01002_001E - Median Age
// B01001_002E to B01001_049E - Age and Sex by Age Groups
// B08301_001E - Means of Transportation to Work
// B15003_022E - Bachelor's Degree
// B15003_023E - Master's Degree
// B15003_024E - Professional Degree
// B15003_025E - Doctorate Degree

// Switch between city and ZIP search
// Switch wizard search type
function switchWizardSearchType(type) {
    const cityForm = document.getElementById('wizard-city-search-form');
    const zipForm = document.getElementById('wizard-zip-search-form');
    const tabs = document.querySelectorAll('#wizard-market-research-form .search-tab-btn');
    
    tabs.forEach(tab => {
        if (tab.dataset.searchType === type) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    });
    
    if (type === 'city') {
        if (cityForm) cityForm.style.display = 'block';
        if (zipForm) zipForm.style.display = 'none';
        document.getElementById('wizard-research-city').required = true;
        document.getElementById('wizard-research-state').required = true;
        document.getElementById('wizard-research-zip').required = false;
    } else {
        if (cityForm) cityForm.style.display = 'none';
        if (zipForm) zipForm.style.display = 'block';
        document.getElementById('wizard-research-city').required = false;
        document.getElementById('wizard-research-state').required = false;
        document.getElementById('wizard-research-zip').required = true;
    }
}

function switchSearchType(type) {
    currentSearchType = type;
    document.querySelectorAll('.search-tab-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.searchType === type) {
            btn.classList.add('active');
        }
    });
    
    const cityForm = document.getElementById('city-search-form');
    const zipForm = document.getElementById('zip-search-form');
    
    if (type === 'city') {
        cityForm.style.display = 'block';
        zipForm.style.display = 'none';
        document.getElementById('research-city').required = true;
        document.getElementById('research-state').required = true;
        document.getElementById('research-zip').required = false;
    } else {
        cityForm.style.display = 'none';
        zipForm.style.display = 'block';
        document.getElementById('research-city').required = false;
        document.getElementById('research-state').required = false;
        document.getElementById('research-zip').required = true;
    }
}
// Wizard-specific market research function
async function searchWizardMarketResearch(e) {
    e.preventDefault();
    
    let cityName, stateCode, zipCode;
    
    // Determine search type based on which form is visible
    const cityForm = document.getElementById('wizard-city-search-form');
    const zipForm = document.getElementById('wizard-zip-search-form');
    const isCitySearch = cityForm && window.getComputedStyle(cityForm).display !== 'none';
    
    if (isCitySearch) {
        cityName = document.getElementById('wizard-research-city').value.trim();
        stateCode = document.getElementById('wizard-research-state').value;
        
        if (!cityName || !stateCode) {
            alert('Please enter both city name and state');
            return;
        }
    } else {
        zipCode = document.getElementById('wizard-research-zip').value.trim();
        
        if (!zipCode || zipCode.length !== 5 || !/^\d{5}$/.test(zipCode)) {
            alert('Please enter a valid 5-digit ZIP code');
            return;
        }
        
        // Get city and state from ZIP code
        try {
            const zipData = await getCityFromZip(zipCode);
            cityName = zipData.city;
            stateCode = zipData.stateCode;
            
            if (cityName && cityName.toLowerCase().includes('county')) {
                throw new Error('County name detected - will use fallback');
            }
            
            if (!cityName || !stateCode) {
                const fallbackData = await getCityFromZipFallback(zipCode);
                if (fallbackData && fallbackData.city && fallbackData.stateCode) {
                    cityName = fallbackData.city;
                    stateCode = fallbackData.stateCode;
                } else {
                    throw new Error('City information not found');
                }
            }
        } catch (error) {
            try {
                const fallbackData = await getCityFromZipFallback(zipCode);
                if (fallbackData && fallbackData.city && fallbackData.stateCode) {
                    if (fallbackData.city.toLowerCase().includes('county')) {
                        throw new Error('Fallback also returned county name');
                    }
                    cityName = fallbackData.city;
                    stateCode = fallbackData.stateCode;
                } else {
                    throw new Error('Fallback also failed');
                }
            } catch (fallbackError) {
                alert(`Could not find city information for ZIP code ${zipCode}. Please use City Search instead.\n\nError: ${error.message}`);
                return;
            }
        }
    }
    // Show loading state
    const submitBtn = document.getElementById('wizard-research-submit-btn');
    const btnText = document.getElementById('wizard-research-btn-text');
    const loadingText = document.getElementById('wizard-research-loading');
    
    btnText.style.display = 'none';
    loadingText.style.display = 'inline';
    submitBtn.disabled = true;
    
    // Hide previous results/errors
    const resultsDiv = document.getElementById('wizard-market-research-results');
    if (resultsDiv) resultsDiv.style.display = 'none';
    
    try {
        if (cityName && cityName.toLowerCase().includes('county')) {
            throw new Error(`"${cityName}" is a county, not a city. Please use City Search instead or try a different ZIP code.`);
        }
        
        // First, get the place FIPS code for the city
        const placeFIPS = await getPlaceFIPS(cityName, stateCode);
        
        if (!placeFIPS) {
            throw new Error(`City "${cityName}" not found in state code ${stateCode}`);
        }
        
        // Fetch demographic data and competition count in parallel
        const [demographics, competitionCount] = await Promise.all([
            fetchCensusData(stateCode, placeFIPS),
            fetchCompetitionCount(cityName, stateCode)
        ]);
        
        // Add competition count to demographics
        demographics.competitionCount = competitionCount;
        demographics.cityName = cityName;
        demographics.stateCode = stateCode;
        demographics.placeFIPS = placeFIPS;
        if (zipCode) demographics.zipCode = zipCode;
        
        // Store research data for wizard
        if (!wizardData) wizardData = {};
        wizardData.city = cityName;
        wizardData.stateCode = stateCode;
        wizardData.researchData = demographics;
        
        // Display results in wizard
        displayWizardMarketResearchResults(cityName, stateCode, demographics);
        
        // Enable Next button
        const nextBtn = document.getElementById('wizard-step-1-next');
        if (nextBtn) nextBtn.disabled = false;
        
    } catch (error) {
        console.error('Wizard Market Research Error:', error);
        let errorMessage = error.message || 'Failed to fetch city data. Please try again.';
        
        if (errorMessage && errorMessage.toLowerCase().includes('county')) {
            errorMessage = `The ZIP code you entered returned a county name instead of a city. This sometimes happens when a ZIP code covers multiple cities or unincorporated areas.\n\nPlease try:\n1. Using City Search instead\n2. Entering a more specific ZIP code for a city\n3. Searching for a nearby city's ZIP code`;
        }
        
        alert(errorMessage);
    } finally {
        // Reset loading state
        btnText.style.display = 'inline';
        loadingText.style.display = 'none';
        submitBtn.disabled = false;
    }
}
async function searchMarketResearch(e) {
    e.preventDefault();
    
    let cityName, stateCode, zipCode;
    
    // Determine search type based on which form is visible
    const cityForm = document.getElementById('city-search-form');
    const zipForm = document.getElementById('zip-search-form');
    const isCitySearch = cityForm && window.getComputedStyle(cityForm).display !== 'none';
    
    if (isCitySearch) {
        cityName = document.getElementById('research-city').value.trim();
        stateCode = document.getElementById('research-state').value;
        
        if (!cityName || !stateCode) {
            alert('Please enter both city name and state');
            return;
        }
    } else {
        zipCode = document.getElementById('research-zip').value.trim();
        
        if (!zipCode || zipCode.length !== 5 || !/^\d{5}$/.test(zipCode)) {
            alert('Please enter a valid 5-digit ZIP code');
            return;
        }
        
        // Get city and state from ZIP code
        try {
            const zipData = await getCityFromZip(zipCode);
            cityName = zipData.city;
            stateCode = zipData.stateCode;
            
            // Check if city name is actually a county (should be caught earlier, but double-check)
            if (cityName && cityName.toLowerCase().includes('county')) {
                console.log('Detected county name, using fallback method');
                throw new Error('County name detected - will use fallback');
            }
            
            if (!cityName || !stateCode) {
                console.error('ZIP code lookup returned empty data:', zipData);
                // Try fallback method
                const fallbackData = await getCityFromZipFallback(zipCode);
                if (fallbackData && fallbackData.city && fallbackData.stateCode) {
                    cityName = fallbackData.city;
                    stateCode = fallbackData.stateCode;
                } else {
                    throw new Error('City information not found');
                }
            }
        } catch (error) {
            console.error('ZIP code lookup error:', error);
            // Try fallback method before giving up (especially if county was detected)
            try {
                const fallbackData = await getCityFromZipFallback(zipCode);
                if (fallbackData && fallbackData.city && fallbackData.stateCode) {
                    // Double-check fallback didn't return a county
                    if (fallbackData.city.toLowerCase().includes('county')) {
                        throw new Error('Fallback also returned county name');
                    }
                    cityName = fallbackData.city;
                    stateCode = fallbackData.stateCode;
                    console.log('Fallback method succeeded:', { cityName, stateCode });
                } else {
                    throw new Error('Fallback also failed');
                }
            } catch (fallbackError) {
                console.error('Fallback method also failed:', fallbackError);
                alert(`Could not find city information for ZIP code ${zipCode}. Please use City Search instead.\n\nError: ${error.message}`);
                return;
            }
        }
    }
    
    // Show loading state
    const submitBtn = document.getElementById('research-submit-btn');
    const btnText = document.getElementById('research-btn-text');
    const loadingText = document.getElementById('research-loading');
    
    btnText.style.display = 'none';
    loadingText.style.display = 'inline';
    submitBtn.disabled = true;
    
    // Hide previous results/errors
    document.getElementById('market-research-results').style.display = 'none';
    document.getElementById('market-research-error').style.display = 'none';
    
    try {
        // Check if city name is actually a county before proceeding
        if (cityName && cityName.toLowerCase().includes('county')) {
            throw new Error(`"${cityName}" is a county, not a city. Please use City Search instead or try a different ZIP code.`);
        }
        
        // First, get the place FIPS code for the city
        const placeFIPS = await getPlaceFIPS(cityName, stateCode);
        
        if (!placeFIPS) {
            throw new Error(`City "${cityName}" not found in state code ${stateCode}`);
        }
        
        // Fetch demographic data and competition count in parallel
        const [demographics, competitionCount] = await Promise.all([
            fetchCensusData(stateCode, placeFIPS),
            fetchCompetitionCount(cityName, stateCode)
        ]);
        
        // Add competition count to demographics
        demographics.competitionCount = competitionCount;
        demographics.cityName = cityName;
        demographics.stateCode = stateCode;
        demographics.placeFIPS = placeFIPS;
        if (zipCode) demographics.zipCode = zipCode;
        
        // Store research data for use in Event Planner
        currentResearchData = demographics;
        
        // Calculate and display results
        displayMarketResearchResults(cityName, stateCode, demographics);
        
    } catch (error) {
        console.error('Market Research Error:', error);
        let errorMessage = error.message || 'Failed to fetch city data. Please try again.';
        
        // If the error is about a county, provide helpful guidance
        if (errorMessage && errorMessage.toLowerCase().includes('county')) {
            errorMessage = `The ZIP code you entered returned a county name instead of a city. This sometimes happens when a ZIP code covers multiple cities or unincorporated areas.\n\nPlease try:\n1. Using City Search instead\n2. Entering a more specific ZIP code for a city\n3. Searching for a nearby city's ZIP code`;
        }
        
        showMarketResearchError(errorMessage);
    } finally {
        // Reset loading state
        btnText.style.display = 'inline';
        loadingText.style.display = 'none';
        submitBtn.disabled = false;
    }
}
// Get city and state from ZIP code using Census API
async function getCityFromZip(zipCode) {
    // Use Census Geocoding API
    const geocodeUrl = `https://geocoding.geo.census.gov/geocoder/geographies/address?street=&zip=${zipCode}&benchmark=Public_AR_Current&vintage=Current_Current&format=json`;
    const proxiedUrl = buildUrlWithProxy(geocodeUrl, getWindowConfig('DESERT_EXCHANGE_GEO_PROXY', DEFAULT_YAHOO_FINANCE_PROXY));
    
    try {
        const response = await fetch(proxiedUrl, {
            cache: 'no-store',
            headers: { accept: 'application/json' },
            mode: 'cors'
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        
        console.log('ZIP code lookup response:', data);
        
        if (data.result && data.result.addressMatches && data.result.addressMatches.length > 0) {
            const match = data.result.addressMatches[0];
            const addressComponents = match.addressComponents;
            
            console.log('Address components:', addressComponents);
            console.log('Geographies:', match.geographies);
            
            // Get city name - try multiple possible fields
            let city = addressComponents.city || 
                      addressComponents.cityName || 
                      addressComponents.placeName || 
                      '';
            
            // Check if city is actually a county name (contains "County")
            if (city.toLowerCase().includes('county')) {
                city = ''; // Clear it, we'll get the actual city from geographies
            }
            
            // Get state code - might be in different formats
            let stateCode = addressComponents.state || 
                           addressComponents.stateCode || 
                           '';
            
            // If state code is a full name, convert to FIPS code
            if (stateCode && stateCode.length > 2) {
                // Convert state name to FIPS code
                const stateNameToFIPS = {
                    'alabama': '01', 'alaska': '02', 'arizona': '04', 'arkansas': '05',
                    'california': '06', 'colorado': '08', 'connecticut': '09', 'delaware': '10',
                    'district of columbia': '11', 'florida': '12', 'georgia': '13', 'hawaii': '15',
                    'idaho': '16', 'illinois': '17', 'indiana': '18', 'iowa': '19',
                    'kansas': '20', 'kentucky': '21', 'louisiana': '22', 'maine': '23',
                    'maryland': '24', 'massachusetts': '25', 'michigan': '26', 'minnesota': '27',
                    'mississippi': '28', 'missouri': '29', 'montana': '30', 'nebraska': '31',
                    'nevada': '32', 'new hampshire': '33', 'new jersey': '34', 'new mexico': '35',
                    'new york': '36', 'north carolina': '37', 'north dakota': '38', 'ohio': '39',
                    'oklahoma': '40', 'oregon': '41', 'pennsylvania': '42', 'rhode island': '44',
                    'south carolina': '45', 'south dakota': '46', 'tennessee': '47', 'texas': '48',
                    'utah': '49', 'vermont': '50', 'virginia': '51', 'washington': '53',
                    'west virginia': '54', 'wisconsin': '55', 'wyoming': '56'
                };
                
                const stateNameLower = stateCode.toLowerCase().trim();
                stateCode = stateNameToFIPS[stateNameLower] || stateCode;
            }
            
            // Try to get city and state from geographies if available
            if (match.geographies) {
                // Get state code from geographies
                if (!stateCode) {
                    if (match.geographies['States'] && match.geographies['States'].length > 0) {
                        stateCode = match.geographies['States'][0].GEOID.substring(0, 2);
                    } else if (match.geographies['2020 Census Blocks'] && match.geographies['2020 Census Blocks'].length > 0) {
                        // Extract state code from GEOID (first 2 digits)
                        const geoid = match.geographies['2020 Census Blocks'][0].GEOID;
                        if (geoid && geoid.length >= 2) {
                            stateCode = geoid.substring(0, 2);
                        }
                    }
                }
                
                // Get city name from Census Places if not already found
                if (!city || city.toLowerCase().includes('county')) {
                    if (match.geographies['Census Places'] && match.geographies['Census Places'].length > 0) {
                        const place = match.geographies['Census Places'][0];
                        city = place.NAME || city;
                        console.log('Got city from Census Places:', city);
                    } else if (match.geographies['2020 Census Blocks'] && match.geographies['2020 Census Blocks'].length > 0) {
                        // Try to get from GEOID - place code is usually in the middle
                        // GEOID format: SSCCCPPPTTTTBBBB (State-County-Census Tract-Tabulation Block)
                        // For place, we might need to use a different API call
                        // For now, let's try the fallback method
                    }
                }
            }
            
            // If we still don't have a city or it's a county, throw error to trigger fallback
            if (!city || city.toLowerCase().includes('county')) {
                console.log('City is missing or is a county, will use fallback method');
                // Don't return here - let the error propagate to trigger fallback
                throw new Error('City name is county or missing - will use fallback');
            }
            
            if (!city || !stateCode) {
                console.error('Missing city or state code:', { city, stateCode, addressComponents, geographies: match.geographies });
                throw new Error('City or state information not found in ZIP code lookup');
            }
            
            console.log('ZIP code lookup result:', { city, stateCode });
            
            return {
                city: city,
                stateCode: stateCode
            };
        }
        
        throw new Error('ZIP code not found in Census database');
    } catch (error) {
        console.error('ZIP lookup error:', error);
        throw new Error(`Failed to lookup ZIP code: ${error.message}`);
    }
}
// Fallback method using Google Geocoding API
async function getCityFromZipFallback(zipCode) {
    try {
        if (typeof google === 'undefined' || !google.maps || !google.maps.Geocoder) {
            // Wait for Google Maps to load
            await waitForGooglePlaces();
        }
        
        const geocoder = new google.maps.Geocoder();
        
        return new Promise((resolve, reject) => {
            geocoder.geocode({ address: zipCode }, (results, status) => {
                if (status === 'OK' && results && results.length > 0) {
                    const result = results[0];
                    let city = '';
                    let stateCode = '';
                    
                    // Parse address components - prioritize city over county
                    for (const component of result.address_components) {
                        // Prioritize locality (city) over administrative_area_level_2 (county)
                        if (component.types.includes('locality')) {
                            city = component.long_name || component.short_name;
                        } else if (!city && component.types.includes('administrative_area_level_2') && !component.long_name.toLowerCase().includes('county')) {
                            // Only use if it's not a county
                            city = component.long_name || component.short_name;
                        }
                        
                        if (component.types.includes('administrative_area_level_1')) {
                            // Get state FIPS code
                            const stateName = component.long_name || component.short_name;
                            const stateNameToFIPS = {
                                'alabama': '01', 'alaska': '02', 'arizona': '04', 'arkansas': '05',
                                'california': '06', 'colorado': '08', 'connecticut': '09', 'delaware': '10',
                                'district of columbia': '11', 'florida': '12', 'georgia': '13', 'hawaii': '15',
                                'idaho': '16', 'illinois': '17', 'indiana': '18', 'iowa': '19',
                                'kansas': '20', 'kentucky': '21', 'louisiana': '22', 'maine': '23',
                                'maryland': '24', 'massachusetts': '25', 'michigan': '26', 'minnesota': '27',
                                'mississippi': '28', 'missouri': '29', 'montana': '30', 'nebraska': '31',
                                'nevada': '32', 'new hampshire': '33', 'new jersey': '34', 'new mexico': '35',
                                'new york': '36', 'north carolina': '37', 'north dakota': '38', 'ohio': '39',
                                'oklahoma': '40', 'oregon': '41', 'pennsylvania': '42', 'rhode island': '44',
                                'south carolina': '45', 'south dakota': '46', 'tennessee': '47', 'texas': '48',
                                'utah': '49', 'vermont': '50', 'virginia': '51', 'washington': '53',
                                'west virginia': '54', 'wisconsin': '55', 'wyoming': '56'
                            };
                            
                            const stateNameLower = stateName.toLowerCase();
                            stateCode = stateNameToFIPS[stateNameLower] || '';
                            
                            // Try short name if long name didn't work
                            if (!stateCode && component.short_name) {
                                const shortNameLower = component.short_name.toLowerCase();
                                // Map common state abbreviations
                                const stateAbbrToFIPS = {
                                    'al': '01', 'ak': '02', 'az': '04', 'ar': '05',
                                    'ca': '06', 'co': '08', 'ct': '09', 'de': '10',
                                    'dc': '11', 'fl': '12', 'ga': '13', 'hi': '15',
                                    'id': '16', 'il': '17', 'in': '18', 'ia': '19',
                                    'ks': '20', 'ky': '21', 'la': '22', 'me': '23',
                                    'md': '24', 'ma': '25', 'mi': '26', 'mn': '27',
                                    'ms': '28', 'mo': '29', 'mt': '30', 'ne': '31',
                                    'nv': '32', 'nh': '33', 'nj': '34', 'nm': '35',
                                    'ny': '36', 'nc': '37', 'nd': '38', 'oh': '39',
                                    'ok': '40', 'or': '41', 'pa': '42', 'ri': '44',
                                    'sc': '45', 'sd': '46', 'tn': '47', 'tx': '48',
                                    'ut': '49', 'vt': '50', 'va': '51', 'wa': '53',
                                    'wv': '54', 'wi': '55', 'wy': '56'
                                };
                                stateCode = stateAbbrToFIPS[shortNameLower] || '';
                            }
                        }
                    }
                    
                    // If still no city, try postal_town or sublocality
                    if (!city || city.toLowerCase().includes('county')) {
                        for (const component of result.address_components) {
                            if (component.types.includes('postal_town') || component.types.includes('sublocality')) {
                                city = component.long_name || component.short_name;
                                if (city && !city.toLowerCase().includes('county')) {
                                    break;
                                }
                            }
                        }
                    }
                    // Last resort: try to extract from formatted_address
                    if (!city || city.toLowerCase().includes('county')) {
                        const formattedAddress = result.formatted_address || '';
                        // Extract city from formatted address (usually first part before comma)
                        const parts = formattedAddress.split(',');
                        if (parts.length > 0) {
                            const potentialCity = parts[0].trim();
                            if (potentialCity && !potentialCity.toLowerCase().includes('county')) {
                                city = potentialCity;
                            }
                        }
                    }
                    // Final check: make sure we got a city (not a county)
                    if (!city || city.toLowerCase().includes('county')) {
                        reject(new Error('Google Geocoding returned a county name instead of a city. Please use City Search instead.'));
                        return;
                    }
                    
                    if (city && stateCode) {
                        console.log('Fallback ZIP lookup result:', { city, stateCode });
                        resolve({ city, stateCode });
                    } else {
                        reject(new Error('Could not extract city and state from geocoding result'));
                    }
                } else {
                    reject(new Error(`Geocoding failed: ${status}`));
                }
            });
        });
    } catch (error) {
        console.error('Fallback ZIP lookup error:', error);
        throw error;
    }
}

// Fetch competition count using Google Places API
async function fetchCompetitionCount(cityName, stateCode) {
    // Note: This requires a Google Places API key
    // For now, we'll return a placeholder or use a mock
    if (GOOGLE_PLACES_API_KEY === 'YOUR_GOOGLE_PLACES_API_KEY') {
        // Return mock data if API key not configured
        console.warn('Google Places API key not configured. Using mock competition count.');
        return Math.floor(Math.random() * 20) + 5; // Random number between 5-25
    }
    
    try {
        // Search for "gold buyer" in the city
        const query1 = `gold buyer ${cityName} ${getStateName(stateCode)}`;
        const url1 = `${GOOGLE_PLACES_BASE_URL}?query=${encodeURIComponent(query1)}&key=${GOOGLE_PLACES_API_KEY}`;
        
        // Search for "pawn shop" in the city
        const query2 = `pawn shop ${cityName} ${getStateName(stateCode)}`;
        const url2 = `${GOOGLE_PLACES_BASE_URL}?query=${encodeURIComponent(query2)}&key=${GOOGLE_PLACES_API_KEY}`;
        const placesProxy = getWindowConfig('DESERT_EXCHANGE_PLACES_PROXY', DEFAULT_YAHOO_FINANCE_PROXY);
        const requestUrl1 = buildUrlWithProxy(url1, placesProxy);
        const requestUrl2 = buildUrlWithProxy(url2, placesProxy);

        const [response1, response2] = await Promise.all([
            fetch(requestUrl1, {
                cache: 'no-store',
                headers: { accept: 'application/json' },
                mode: 'cors'
            }),
            fetch(requestUrl2, {
                cache: 'no-store',
                headers: { accept: 'application/json' },
                mode: 'cors'
            })
        ]);

        if (!response1.ok) {
            throw new Error(`Google Places error (gold buyer): ${response1.status}`);
        }
        if (!response2.ok) {
            throw new Error(`Google Places error (pawn shop): ${response2.status}`);
        }
        
        const data1 = await response1.json();
        const data2 = await response2.json();
        
        const goldBuyers = data1.results ? data1.results.length : 0;
        const pawnShops = data2.results ? data2.results.length : 0;
        
        return goldBuyers + pawnShops;
    } catch (error) {
        console.error('Competition count error:', error);
        // Return mock data on error
        return Math.floor(Math.random() * 20) + 5;
    }
}

async function getPlaceFIPS(cityName, stateCode) {
    // Check if city name is actually a county (should not happen, but safety check)
    if (cityName && cityName.toLowerCase().includes('county')) {
        throw new Error(`"${cityName}" is a county, not a city. Please use City Search or a different ZIP code.`);
    }
    
    // Use Census Geocoding API to find place FIPS code
    // For now, we'll use a direct approach with the Census Geocoder API
    const geocodeUrl = `https://geocoding.geo.census.gov/geocoder/geographies/address?street=&city=${encodeURIComponent(cityName)}&state=${stateCode}&benchmark=Public_AR_Current&vintage=Current_Current&format=json`;
    const proxiedUrl = buildUrlWithProxy(geocodeUrl, getWindowConfig('DESERT_EXCHANGE_GEO_PROXY', DEFAULT_YAHOO_FINANCE_PROXY));
    
    try {
        const response = await fetch(proxiedUrl, {
            cache: 'no-store',
            headers: { accept: 'application/json' },
            mode: 'cors'
        });
        const data = await response.json();
        
        if (data.result && data.result.addressMatches && data.result.addressMatches.length > 0) {
            const match = data.result.addressMatches[0];
            if (match.geographies && match.geographies['Census Places'] && match.geographies['Census Places'].length > 0) {
                return match.geographies['Census Places'][0].GEOID.substring(2); // Remove state code prefix
            }
        }
        
        // Fallback: try to get place data directly from Census API with place name
        return await getPlaceFIPSFromName(cityName, stateCode);
        
    } catch (error) {
        console.error('Geocoding error:', error);
        // Fallback to direct place lookup
        return await getPlaceFIPSFromName(cityName, stateCode);
    }
}

async function getPlaceFIPSFromName(cityName, stateCode) {
    // Use Census Places API to find FIPS code
    const placesUrl = `https://api.census.gov/data/2021/acs/acs5?get=NAME&for=place:*&in=state:${stateCode}&key=${CENSUS_API_KEY}`;
    
    try {
        const response = await fetch(placesUrl);
        const data = await response.json();
        
        if (data && data.length > 1) {
            // Search for matching city name
            const cityLower = cityName.toLowerCase();
            for (let i = 1; i < data.length; i++) {
                const placeName = data[i][0].toLowerCase();
                if (placeName.includes(cityLower) || cityLower.includes(placeName.split(',')[0])) {
                    return data[i][2]; // Place FIPS code
                }
            }
        }
        
        return null;
    } catch (error) {
        console.error('Place lookup error:', error);
        return null;
    }
}
async function fetchCensusData(stateCode, placeFIPS) {
    // Split into multiple API calls to stay under 50 variable limit
    
    // First call: Basic demographics (under 50 variables)
    const basicVariables = [
        'B01001_001E',  // Total Population
        'B19013_001E',  // Median Household Income
        'B25077_001E',  // Median Home Value
        'B01002_001E',  // Median Age
        'B25003_001E',  // Total Housing Units
        'B25003_002E',  // Owner-Occupied Housing Units
        'NAME'
    ];
    
    // Second call: Age distribution - Male (under 50 variables)
    const maleAgeVariables = [
        'B01001_003E',  // Male: Under 5 years
        'B01001_004E',  // Male: 5 to 9 years
        'B01001_005E',  // Male: 10 to 14 years
        'B01001_006E',  // Male: 15 to 17 years
        'B01001_007E',  // Male: 18 and 19 years
        'B01001_008E',  // Male: 20 years
        'B01001_009E',  // Male: 21 years
        'B01001_010E',  // Male: 22 to 24 years
        'B01001_011E',  // Male: 25 to 29 years
        'B01001_012E',  // Male: 30 to 34 years
        'B01001_013E',  // Male: 35 to 39 years
        'B01001_014E',  // Male: 40 to 44 years
        'B01001_015E',  // Male: 45 to 49 years
        'B01001_016E',  // Male: 50 to 54 years
        'B01001_017E',  // Male: 55 to 59 years
        'B01001_018E',  // Male: 60 and 61 years
        'B01001_019E',  // Male: 62 to 64 years
        'B01001_020E',  // Male: 65 and 66 years
        'B01001_021E',  // Male: 67 to 69 years
        'B01001_022E',  // Male: 70 to 74 years
        'B01001_023E',  // Male: 75 to 79 years
        'B01001_024E',  // Male: 80 to 84 years
        'B01001_025E',  // Male: 85 years and over
        'NAME'
    ];
    
    // Third call: Age distribution - Female (under 50 variables)
    const femaleAgeVariables = [
        'B01001_027E',  // Female: Under 5 years
        'B01001_028E',  // Female: 5 to 9 years
        'B01001_029E',  // Female: 10 to 14 years
        'B01001_030E',  // Female: 15 to 17 years
        'B01001_031E',  // Female: 18 and 19 years
        'B01001_032E',  // Female: 20 years
        'B01001_033E',  // Female: 21 years
        'B01001_034E',  // Female: 22 to 24 years
        'B01001_035E',  // Female: 25 to 29 years
        'B01001_036E',  // Female: 30 to 34 years
        'B01001_037E',  // Female: 35 to 39 years
        'B01001_038E',  // Female: 40 to 44 years
        'B01001_039E',  // Female: 45 to 49 years
        'B01001_040E',  // Female: 50 to 54 years
        'B01001_041E',  // Female: 55 to 59 years
        'B01001_042E',  // Female: 60 and 61 years
        'B01001_043E',  // Female: 62 to 64 years
        'B01001_044E',  // Female: 65 and 66 years
        'B01001_045E',  // Female: 67 to 69 years
        'B01001_046E',  // Female: 70 to 74 years
        'B01001_047E',  // Female: 75 to 79 years
        'B01001_048E',  // Female: 80 to 84 years
        'B01001_049E',  // Female: 85 years and over
        'NAME'
    ];
    
    // Make all API calls in parallel
    const [basicData, maleAgeData, femaleAgeData] = await Promise.all([
        fetchCensusVariables(basicVariables, stateCode, placeFIPS),
        fetchCensusVariables(maleAgeVariables, stateCode, placeFIPS),
        fetchCensusVariables(femaleAgeVariables, stateCode, placeFIPS)
    ]);
    
    // Combine all results
    return {
        ...basicData,
        ...maleAgeData,
        ...femaleAgeData
    };
}

async function fetchCensusVariables(variables, stateCode, placeFIPS) {
    const variablesString = variables.join(',');
    const url = `${CENSUS_BASE_URL}?get=${variablesString}&for=place:${placeFIPS}&in=state:${stateCode}&key=${CENSUS_API_KEY}`;
    
    const response = await fetch(url);
    
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Census API error: ${response.status} - ${errorText}`);
    }
    
    const data = await response.json();
    
    if (!data || data.length < 2) {
        throw new Error('No data returned from Census API');
    }
    
    // Parse the data
    const headers = data[0];
    const values = data[1];
    
    const result = {};
    headers.forEach((header, index) => {
        const value = values[index];
        // Handle null values and error codes (-999999999, -888888888, etc.)
        if (value === null || value === '-999999999' || value === '-888888888' || value === '-666666666') {
            result[header] = null;
        } else {
            // Parse numeric values
            const numValue = parseFloat(value);
            result[header] = isNaN(numValue) ? value : Math.round(numValue);
        }
    });
    
    return result;
}
// Display wizard market research results
function displayWizardMarketResearchResults(cityName, stateCode, data) {
    // Show results section
    const resultsDiv = document.getElementById('wizard-market-research-results');
    if (resultsDiv) resultsDiv.style.display = 'block';
    
    // Update city name
    const cityNameEl = document.getElementById('wizard-results-city-name');
    if (cityNameEl) cityNameEl.textContent = `${cityName}, ${getStateName(stateCode)}`;
    
    // Update demographic data
    const populationEl = document.getElementById('wizard-result-population');
    if (populationEl) populationEl.textContent = formatNumber(data.B01001_001E || 0);
    
    const incomeEl = document.getElementById('wizard-result-income');
    if (incomeEl) incomeEl.textContent = formatCurrency(data.B19013_001E || 0);
    
    const ageEl = document.getElementById('wizard-result-age');
    if (ageEl) ageEl.textContent = data.B01002_001E ? `${data.B01002_001E.toFixed(1)} years` : '-';
    
    const homeValueEl = document.getElementById('wizard-result-home-value');
    if (homeValueEl) homeValueEl.textContent = formatCurrency(data.B25077_001E || 0);
    
    const homeownershipEl = document.getElementById('wizard-result-homeownership');
    if (homeownershipEl) {
        const homeownershipRate = data.B25003_002E && data.B25003_001E 
            ? ((data.B25003_002E / data.B25003_001E) * 100).toFixed(1) 
            : 0;
        homeownershipEl.textContent = `${homeownershipRate}%`;
    }
    
    const competitionEl = document.getElementById('wizard-result-competition');
    if (competitionEl) competitionEl.textContent = `${data.competitionCount || 0} businesses`;
    
    // Calculate and display opportunity score
    const score = calculateProfitOpportunityScore(data);
    const scoreEl = document.getElementById('wizard-opportunity-score');
    if (scoreEl) scoreEl.textContent = `${score.toFixed(0)}/100`;
    
    const scoreBarEl = document.getElementById('wizard-score-bar-fill');
    if (scoreBarEl) {
        scoreBarEl.style.width = `${score}%`;
        if (score >= 70) {
            scoreBarEl.style.background = '#10b981';
        } else if (score >= 40) {
            scoreBarEl.style.background = '#f59e0b';
        } else {
            scoreBarEl.style.background = '#ef4444';
        }
    }
    
    const scoreDescEl = document.getElementById('wizard-score-description');
    if (scoreDescEl) {
        if (score >= 70) {
            scoreDescEl.textContent = 'Excellent opportunity - High profit potential';
        } else if (score >= 40) {
            scoreDescEl.textContent = 'Moderate opportunity - Consider market conditions';
        } else {
            scoreDescEl.textContent = 'Low opportunity - High competition or low demographics';
        }
    }
    
    // Show selected city card
    const citySelectionDiv = document.getElementById('wizard-city-selection');
    if (citySelectionDiv) {
        citySelectionDiv.style.display = 'block';
        const cityInfoEl = document.getElementById('wizard-selected-city-info');
        if (cityInfoEl) {
            cityInfoEl.innerHTML = `
                <div><strong>${cityName}, ${getStateName(stateCode)}</strong></div>
                <div>Population: ${formatNumber(data.B01001_001E || 0)}</div>
                <div>Median Income: ${formatCurrency(data.B19013_001E || 0)}</div>
                <div>Opportunity Score: ${score.toFixed(0)}/100</div>
            `;
        }
    }
}
function displayMarketResearchResults(cityName, stateCode, data) {
    // Update city name
    document.getElementById('results-city-name').textContent = `${cityName}, ${getStateName(stateCode)}`;
    
    // Display main demographics
    document.getElementById('result-population').textContent = formatNumber(data.B01001_001E || 0);
    document.getElementById('result-income').textContent = formatCurrency(data.B19013_001E || 0);
    document.getElementById('result-age').textContent = data.B01002_001E ? `${data.B01002_001E.toFixed(1)} years` : '-';
    document.getElementById('result-home-value').textContent = formatCurrency(data.B25077_001E || 0);
    
    // Calculate and display homeownership rate
    const homeownershipRate = data.B25003_002E && data.B25003_001E 
        ? ((data.B25003_002E / data.B25003_001E) * 100).toFixed(1) + '%'
        : '-';
    document.getElementById('result-homeownership').textContent = homeownershipRate;
    
    // Display competition count
    document.getElementById('result-competition').textContent = formatNumber(data.competitionCount || 0);
    
    // Calculate and display Profit Opportunity Score
    const opportunityScore = calculateProfitOpportunityScore(data);
    displayOpportunityScore(opportunityScore);
    
    // Display age distribution
    displayAgeDistribution(data);
    
    // Show results
    document.getElementById('market-research-results').style.display = 'block';
}
// Calculate Profit Opportunity Score based on demographics and competition
function calculateProfitOpportunityScore(data) {
    let score = 0;
    const maxScore = 100;
    
    // Population factor (0-25 points)
    // Higher population = more potential customers
    const population = data.B01001_001E || 0;
    if (population > 1000000) score += 25;
    else if (population > 500000) score += 20;
    else if (population > 250000) score += 15;
    else if (population > 100000) score += 10;
    else if (population > 50000) score += 5;
    
    // Income factor (0-30 points)
    // Higher income = more disposable income for gold buying
    const income = data.B19013_001E || 0;
    if (income > 100000) score += 30;
    else if (income > 75000) score += 25;
    else if (income > 60000) score += 20;
    else if (income > 50000) score += 15;
    else if (income > 40000) score += 10;
    else if (income > 30000) score += 5;
    
    // Competition factor (0-25 points)
    // Lower competition = higher opportunity
    const competition = data.competitionCount || 0;
    if (competition === 0) score += 25;
    else if (competition <= 5) score += 20;
    else if (competition <= 10) score += 15;
    else if (competition <= 15) score += 10;
    else if (competition <= 20) score += 5;
    // More than 20 competitors = 0 points
    
    // Homeownership factor (0-10 points)
    // Higher homeownership = more assets (gold jewelry)
    const homeownership = data.B25003_002E && data.B25003_001E 
        ? (data.B25003_002E / data.B25003_001E) * 100
        : 50; // Default to 50% if not available
    if (homeownership > 70) score += 10;
    else if (homeownership > 60) score += 7;
    else if (homeownership > 50) score += 5;
    else if (homeownership > 40) score += 3;
    
    // Age factor (0-10 points)
    // Middle-aged population (35-65) more likely to own gold
    const medianAge = data.B01002_001E || 40;
    if (medianAge >= 35 && medianAge <= 65) score += 10;
    else if (medianAge >= 30 && medianAge <= 70) score += 7;
    else if (medianAge >= 25 && medianAge <= 75) score += 5;
    else score += 2;
    
    return Math.min(Math.max(score, 0), maxScore); // Clamp between 0-100
}

// Display Profit Opportunity Score
function displayOpportunityScore(score) {
    const scoreEl = document.getElementById('opportunity-score');
    const barFill = document.getElementById('score-bar-fill');
    const descriptionEl = document.getElementById('score-description');
    
    scoreEl.textContent = score.toFixed(0) + '/100';
    
    // Set bar width
    barFill.style.width = `${score}%`;
    
    // Set bar color based on score
    if (score >= 75) {
        barFill.style.background = 'linear-gradient(135deg, #10b981 0%, #059669 100%)';
        descriptionEl.textContent = 'Excellent opportunity - High potential for success';
        descriptionEl.style.color = '#10b981';
    } else if (score >= 50) {
        barFill.style.background = 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)';
        descriptionEl.textContent = 'Good opportunity - Moderate potential';
        descriptionEl.style.color = '#f59e0b';
    } else if (score >= 25) {
        barFill.style.background = 'linear-gradient(135deg, #f97316 0%, #ea580c 100%)';
        descriptionEl.textContent = 'Fair opportunity - Consider carefully';
        descriptionEl.style.color = '#f97316';
    } else {
        barFill.style.background = 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)';
        descriptionEl.textContent = 'Low opportunity - May be challenging';
        descriptionEl.style.color = '#ef4444';
    }
}
function displayAgeDistribution(data) {
    const ageGroups = [
        { label: 'Under 5', male: 'B01001_003E', female: 'B01001_027E' },
        { label: '5-9', male: 'B01001_004E', female: 'B01001_028E' },
        { label: '10-14', male: 'B01001_005E', female: 'B01001_029E' },
        { label: '15-17', male: 'B01001_006E', female: 'B01001_030E' },
        { label: '18-19', male: 'B01001_007E', female: 'B01001_031E' },
        { label: '20-24', male: ['B01001_008E', 'B01001_009E', 'B01001_010E'], female: ['B01001_032E', 'B01001_033E', 'B01001_034E'] },
        { label: '25-29', male: 'B01001_011E', female: 'B01001_035E' },
        { label: '30-34', male: 'B01001_012E', female: 'B01001_036E' },
        { label: '35-39', male: 'B01001_013E', female: 'B01001_037E' },
        { label: '40-44', male: 'B01001_014E', female: 'B01001_038E' },
        { label: '45-49', male: 'B01001_015E', female: 'B01001_039E' },
        { label: '50-54', male: 'B01001_016E', female: 'B01001_040E' },
        { label: '55-59', male: 'B01001_017E', female: 'B01001_041E' },
        { label: '60-64', male: ['B01001_018E', 'B01001_019E'], female: ['B01001_042E', 'B01001_043E'] },
        { label: '65-69', male: ['B01001_020E', 'B01001_021E'], female: ['B01001_044E', 'B01001_045E'] },
        { label: '70-74', male: 'B01001_022E', female: 'B01001_046E' },
        { label: '75-79', male: 'B01001_023E', female: 'B01001_047E' },
        { label: '80-84', male: 'B01001_024E', female: 'B01001_048E' },
        { label: '85+', male: 'B01001_025E', female: 'B01001_049E' }
    ];
    
    const ageGrid = document.getElementById('age-distribution-grid');
    ageGrid.innerHTML = '';
    
    ageGroups.forEach(group => {
        let maleCount = 0;
        let femaleCount = 0;
        
        // Handle array of variables
        if (Array.isArray(group.male)) {
            maleCount = group.male.reduce((sum, varName) => sum + (data[varName] || 0), 0);
        } else {
            maleCount = data[group.male] || 0;
        }
        
        if (Array.isArray(group.female)) {
            femaleCount = group.female.reduce((sum, varName) => sum + (data[varName] || 0), 0);
        } else {
            femaleCount = data[group.female] || 0;
        }
        
        const total = maleCount + femaleCount;
        const percentage = data.B01001_001E > 0 ? ((total / data.B01001_001E) * 100).toFixed(1) : 0;
        
        ageGrid.innerHTML += `
            <div class="age-group-card">
                <div class="age-group-label">${group.label}</div>
                <div class="age-group-value">${formatNumber(total)}</div>
                <div class="age-group-percentage">${percentage}%</div>
            </div>
        `;
    });
}

function displayAdditionalStats(data) {
    const statsGrid = document.getElementById('additional-stats-grid');
    statsGrid.innerHTML = '';
    
    // Add any additional statistics here
    // For now, we'll just show that more data is available
}

// ============================================
// EVENT PLANNER FUNCTIONS
// ============================================

// Open Event Planner modal
function openEventPlannerModal(eventId = null) {
    const modal = document.getElementById('event-planner-modal');
    const form = document.getElementById('event-planner-form');
    const title = document.getElementById('event-planner-title');
    const deleteBtn = document.getElementById('delete-event-btn');
    
    // Reset form
    form.reset();
    document.getElementById('planner-event-id').value = '';
    
    // If editing existing event
    if (eventId) {
        const events = getPlannedEvents();
        const event = events.find(e => e.id === eventId);
        if (event) {
            title.textContent = 'Edit Event';
            deleteBtn.style.display = 'inline-block';
            deleteBtn.dataset.eventId = eventId;
            
            // Fill form with event data
            document.getElementById('planner-event-name').value = event.name || '';
            document.getElementById('planner-start-date').value = event.startDate || '';
            document.getElementById('planner-end-date').value = event.endDate || '';
            document.getElementById('planner-venue').value = event.venue || '';
            document.getElementById('planner-notes').value = event.notes || '';
            document.getElementById('planner-estimated-spend').value = event.estimatedSpend || '';
            document.getElementById('planner-estimated-roi').value = event.estimatedROI || '';
            document.getElementById('planner-status').value = event.status || 'draft';
            document.getElementById('planner-event-id').value = eventId;
            
            // Display research data if available
            if (event.researchData) {
                displayResearchDataInForm(event.researchData);
            }
        }
    } else {
        title.textContent = 'Create Event';
        deleteBtn.style.display = 'none';
        
        // If research data is available, pre-fill it
        if (currentResearchData) {
            displayResearchDataInForm(currentResearchData);
        }
    }
    
    modal.style.display = 'flex';
    modal.style.alignItems = 'center';
    modal.style.justifyContent = 'center';
}

// Display research data in the form
function displayResearchDataInForm(data) {
    const researchSection = document.getElementById('planner-research-data');
    const researchGrid = document.getElementById('planner-research-grid');
    
    if (!data || !researchSection || !researchGrid) return;
    
    researchGrid.innerHTML = `
        <div class="research-data-item">
            <label>City:</label>
            <span>${data.cityName || '-'}, ${getStateName(data.stateCode || '')}</span>
        </div>
        <div class="research-data-item">
            <label>Population:</label>
            <span>${formatNumber(data.B01001_001E || 0)}</span>
        </div>
        <div class="research-data-item">
            <label>Median Income:</label>
            <span>${formatCurrency(data.B19013_001E || 0)}</span>
        </div>
        <div class="research-data-item">
            <label>Competition:</label>
            <span>${formatNumber(data.competitionCount || 0)} competitors</span>
        </div>
        <div class="research-data-item">
            <label>Opportunity Score:</label>
            <span>${calculateProfitOpportunityScore(data).toFixed(0)}/100</span>
        </div>
    `;
    
    researchSection.style.display = 'block';
}
// Close Event Planner modal
function closeEventPlannerModal() {
    const modal = document.getElementById('event-planner-modal');
    modal.style.display = 'none';
}
// Save planned event
function savePlannedEvent(e) {
    e.preventDefault();
    
    const eventId = document.getElementById('planner-event-id').value;
    const eventName = document.getElementById('planner-event-name').value.trim();
    const startDate = document.getElementById('planner-start-date').value;
    const endDate = document.getElementById('planner-end-date').value;
    const venue = document.getElementById('planner-venue').value.trim();
    const notes = document.getElementById('planner-notes').value.trim();
    const estimatedSpend = parseFloat(document.getElementById('planner-estimated-spend').value) || 0;
    const estimatedROI = parseFloat(document.getElementById('planner-estimated-roi').value) || 0;
    const status = document.getElementById('planner-status').value;
    
    if (!eventName || !startDate) {
        alert('Please enter event name and start date');
        return;
    }
    
    const events = getPlannedEvents();
    
    if (eventId) {
        // Update existing event
        const index = events.findIndex(e => e.id === eventId);
        if (index !== -1) {
            events[index] = {
                ...events[index],
                name: eventName,
                startDate,
                endDate,
                venue,
                notes,
                estimatedSpend,
                estimatedROI,
                status,
                updatedAt: new Date().toISOString()
            };
        }
    } else {
        // Create new event
        const newEvent = {
            id: Date.now().toString(),
            name: eventName,
            startDate,
            endDate,
            venue,
            notes,
            estimatedSpend,
            estimatedROI,
            status,
            researchData: currentResearchData ? { ...currentResearchData } : null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        events.push(newEvent);
    }
    
    savePlannedEvents(events);
    loadEventList();
    closeEventPlannerModal();
    
    // If status is 'active', also create/update in main event system
    if (status === 'active') {
        const plannedEvent = events.find(e => eventId ? e.id === eventId : e.id === events[events.length - 1].id);
        if (plannedEvent) {
            linkEventToMainSystem(plannedEvent).then(() => {
                console.log('Planned event linked to main system');
            }).catch(error => {
                console.error('Error linking planned event:', error);
            });
        }
    }
    
    alert('Event saved successfully!');
}
// Delete planned event
function deletePlannedEvent() {
    const eventId = document.getElementById('planner-event-id').value;
    if (!eventId) return;
    
    if (!confirm('Are you sure you want to delete this event?')) return;
    
    const events = getPlannedEvents();
    const filtered = events.filter(e => e.id !== eventId);
    savePlannedEvents(filtered);
    loadEventList();
    closeEventPlannerModal();
    alert('Event deleted successfully!');
}
// Load and display event list
function loadEventList() {
    const events = getPlannedEvents();
    const container = document.getElementById('event-list-container');
    
    if (!container) return;
    
    if (events.length === 0) {
        container.innerHTML = '<p class="empty-message">No events created yet. Click "Create New Event" to get started.</p>';
        return;
    }
    
    // Sort events by start date (newest first)
    const sortedEvents = events.sort((a, b) => new Date(b.startDate || b.createdAt) - new Date(a.startDate || a.createdAt));
    
    container.innerHTML = sortedEvents.map(event => {
        const statusClass = `status-${event.status}`;
        const statusLabel = event.status.charAt(0).toUpperCase() + event.status.slice(1);
        const opportunityScore = event.researchData ? calculateProfitOpportunityScore(event.researchData).toFixed(0) : '-';
        const hasEndDate = event.endDate ? `<div class="event-info-item">
                            <label>End Date:</label>
                            <span>${new Date(event.endDate).toLocaleDateString()}</span>
                        </div>` : '';
        const hasVenue = event.venue ? `<div class="event-info-item">
                            <label>Venue:</label>
                            <span>${event.venue}</span>
                        </div>` : '';
        const hasSpend = event.estimatedSpend > 0 ? `<div class="event-info-item">
                            <label>Est. Spend:</label>
                            <span>${formatCurrency(event.estimatedSpend)}</span>
                        </div>` : '';
        const hasROI = event.estimatedROI > 0 ? `<div class="event-info-item">
                            <label>Est. ROI:</label>
                            <span>${event.estimatedROI}%</span>
                        </div>` : '';
        const hasScore = opportunityScore !== '-' ? `<div class="event-info-item">
                            <label>Opportunity Score:</label>
                            <span>${opportunityScore}/100</span>
                        </div>` : '';
        const hasNotes = event.notes ? `<div class="event-notes">
                        <label>Notes:</label>
                        <p>${event.notes}</p>
                    </div>` : '';
        const dashboardButton = event.status === 'active' ? `<button class="btn-primary btn-sm" onclick="viewEventInDashboard('${event.id}')">View in Dashboard</button>` : '';
        
        return `<div class="event-card">
                <div class="event-card-header">
                    <h4 class="event-name">${event.name}</h4>
                    <span class="event-status ${statusClass}">${statusLabel}</span>
                </div>
                <div class="event-card-body">
                    <div class="event-info-grid">
                        <div class="event-info-item">
                            <label>Start Date:</label>
                            <span>${event.startDate ? new Date(event.startDate).toLocaleDateString() : '-'}</span>
                        </div>
                        ${hasEndDate}
                        ${hasVenue}
                        ${hasSpend}
                        ${hasROI}
                        ${hasScore}
                    </div>
                    ${hasNotes}
                    <div class="event-actions">
                        <button class="btn-secondary btn-sm" onclick="editPlannedEvent('${event.id}')">Edit</button>
                        ${dashboardButton}
                    </div>
                </div>
            </div>`;
    }).join('');
}

// Edit planned event
function editPlannedEvent(eventId) {
    openEventPlannerModal(eventId);
}
// View event in main dashboard (if active)
function viewEventInDashboard(eventId) {
    const events = getPlannedEvents();
    const event = events.find(e => e.id === eventId);
    
    if (!event || event.status !== 'active') {
        alert('Event must be active to view in dashboard');
        return;
    }
    
    // Link to main event system if not already linked
    linkEventToMainSystem(event).then(mainEvent => {
        // Switch to dashboard tab
        switchTab('dashboard');
        
        // Select the event in the event selector
        const eventSelector = document.getElementById('event-selector');
        if (eventSelector && mainEvent) {
            eventSelector.value = mainEvent.id;
            loadEvent();
        }
    }).catch(error => {
        console.error('Error linking event to main system:', error);
        alert('Error linking event to main system. Please try again.');
    });
}
// Link planned event to main event system
async function linkEventToMainSystem(plannedEvent) {
    // Check if event already exists by name (in cache or localStorage)
    let mainEvent = eventsCache.find(e => e.name === plannedEvent.name);
    
    if (!mainEvent) {
        // Check localStorage as fallback
        const mainEvents = JSON.parse(localStorage.getItem('events') || '[]');
        mainEvent = mainEvents.find(e => e.name === plannedEvent.name);
    }
    
    if (!mainEvent) {
        // Create new event in main system
        mainEvent = {
            id: null, // Will be set by Supabase
            name: plannedEvent.name,
            created: plannedEvent.startDate || new Date().toISOString().split('T')[0],
            date: plannedEvent.startDate || new Date().toISOString().split('T')[0],
            status: 'active',
            buyList: [],
            sales: [],
            expenses: [],
            plannedEventId: plannedEvent.id // Link back to planned event
        };
        
        try {
            // Save to Supabase
            const eventId = await saveEventToDB(mainEvent);
            mainEvent.id = eventId;
            
            // Update cache
            eventsCache.push(mainEvent);
            
            // Also save to localStorage as fallback
            const mainEvents = JSON.parse(localStorage.getItem('events') || '[]');
            mainEvents.push(mainEvent);
            localStorage.setItem('events', JSON.stringify(mainEvents));
            
            // Refresh event selector dropdown
            await loadEvents();
            
            console.log('Planned event linked to main system:', mainEvent);
        } catch (error) {
            console.error('Error linking planned event to main system:', error);
            // Fallback to localStorage only
            mainEvent.id = Date.now().toString();
            const mainEvents = JSON.parse(localStorage.getItem('events') || '[]');
            mainEvents.push(mainEvent);
            localStorage.setItem('events', JSON.stringify(mainEvents));
            
            // Update cache
            eventsCache.push(mainEvent);
            
            // Refresh event selector dropdown
            await loadEvents();
        }
    }
    
    return mainEvent;
}

// ============================================
// EVENT PLANNING WIZARD
// ============================================

// Wizard data storage
let wizardData = {
    city: null,
    researchData: null,
    venue: null,
    licenses: null,
    licenseNotes: ''
};

// Helper function to safely get city name from wizardData.city (handles both string and object)
function getCityName(city) {
    if (!city) return '';
    if (typeof city === 'string') return city;
    if (city && city.name) return city.name;
    return String(city); // Fallback for other types
}

// Start the wizard
function startWizard() {
    // Reset wizard data
    wizardData = {
        city: null,
        researchData: null,
        venue: null,
        licenses: null,
        licenseNotes: ''
    };
    
    // Show wizard
    const wizard = document.getElementById('event-planning-wizard');
    wizard.style.display = 'block';
    
    // Hide "Start Planning" button
    document.getElementById('create-event-btn').style.display = 'none';
    
    // Go to step 1
    showWizardStep(1);
}
// Show wizard step
function showWizardStep(step) {
    // Hide all steps
    for (let i = 1; i <= 4; i++) {
        const stepContent = document.getElementById(`wizard-step-${i}`);
        if (stepContent) {
            stepContent.style.display = 'none';
        }
        
        const stepNumber = document.querySelector(`.wizard-step[data-step="${i}"] .step-number`);
        const stepLine = document.querySelectorAll('.wizard-line')[i - 1];
        
        if (stepNumber) {
            stepNumber.classList.remove('active', 'completed');
        }
        
        if (stepLine) {
            stepLine.classList.remove('completed');
        }
    }
    
    // Show current step
    const currentStepContent = document.getElementById(`wizard-step-${step}`);
    if (currentStepContent) {
        currentStepContent.style.display = 'block';
    }
    
    // Update progress indicators
    for (let i = 1; i <= 4; i++) {
        const stepNumber = document.querySelector(`.wizard-step[data-step="${i}"] .step-number`);
        const stepLine = document.querySelectorAll('.wizard-line')[i - 1];
        
        if (stepNumber) {
            if (i < step) {
                stepNumber.classList.add('completed');
            } else if (i === step) {
                stepNumber.classList.add('active');
            }
        }
        
        if (stepLine && i < step) {
            stepLine.classList.add('completed');
        }
    }
    
    // Update step-specific content
    if (step === 1) {
        updateWizardStep1();
    } else if (step === 2) {
        updateWizardStep2();
    } else if (step === 3) {
        updateWizardStep3();
    } else if (step === 4) {
        updateWizardStep4();
    }
}
// Update wizard step 1
function updateWizardStep1() {
    const citySelection = document.getElementById('wizard-city-selection');
    const nextBtn = document.getElementById('wizard-step-1-next');
    
    if (wizardData && wizardData.city && wizardData.researchData) {
        if (citySelection) citySelection.style.display = 'block';
        displayWizardCity();
        if (nextBtn) nextBtn.disabled = false;
    } else {
        if (citySelection) citySelection.style.display = 'none';
        if (nextBtn) nextBtn.disabled = true;
    }
}

// Display city in wizard
function displayWizardCity() {
    const cityInfo = document.getElementById('wizard-selected-city-info');
    if (!cityInfo || !wizardData || !wizardData.researchData) return;
    
    const data = wizardData.researchData;
    const opportunityScore = calculateProfitOpportunityScore(data);
    
    cityInfo.innerHTML = `
        <div class="selected-city-info-item">
            <label>City:</label>
            <span>${getCityName(wizardData.city)}, ${wizardData.stateCode ? getStateName(wizardData.stateCode) : ''}</span>
        </div>
        <div class="selected-city-info-item">
            <label>Population:</label>
            <span>${formatNumber(data.B01001_001E || 0)}</span>
        </div>
        <div class="selected-city-info-item">
            <label>Median Income:</label>
            <span>${formatCurrency(data.B19013_001E || 0)}</span>
        </div>
        <div class="selected-city-info-item">
            <label>Competition:</label>
            <span>${formatNumber(data.competitionCount || 0)} competitors</span>
        </div>
        <div class="selected-city-info-item">
            <label>Opportunity Score:</label>
            <span>${opportunityScore.toFixed(0)}/100</span>
        </div>
    `;
}

// Update wizard step 2
function updateWizardStep2() {
    const selectedVenue = document.getElementById('selected-venue');
    const nextBtn = document.getElementById('wizard-step-2-next');
    
    if (wizardData.venue) {
        selectedVenue.style.display = 'block';
        displayWizardVenue();
        nextBtn.disabled = false;
    } else {
        selectedVenue.style.display = 'none';
        nextBtn.disabled = true;
        
        // Show initial suggestions if city is selected
        if (wizardData.city) {
            showInitialVenueSuggestions();
        }
    }
}
// Show initial venue suggestions based on the selected city
async function showInitialVenueSuggestions() {
    if (!wizardData.city) return;
    
    const results = document.getElementById('venue-results');
    const resultsList = document.getElementById('venue-results-list');
    
    if (!results || !resultsList) return;
    
    // Show loading state
    results.style.display = 'block';
    resultsList.innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--text-secondary);">Loading venue suggestions...</div>';
    
    try {
        // Add timeout to prevent hanging forever
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Venue search timed out. Please try again.')), 15000); // 15 second timeout
        });
        
        // Search for both hotels and conference rooms in the selected city
        const searchQueries = [
            { query: 'hotel', type: 'hotel' },
            { query: 'conference room', type: 'conference' },
            { query: 'conference center', type: 'conference' },
            { query: 'meeting room', type: 'conference' }
        ];
        
        // Fetch venues for each query
        const allVenues = [];
        for (const searchQuery of searchQueries) {
            try {
                const venues = await Promise.race([
                    fetchVenuesFromGooglePlaces(searchQuery.query, wizardData.city),
                    timeoutPromise
                ]);
                allVenues.push(...venues);
            } catch (error) {
                console.error(`Error fetching ${searchQuery.query}:`, error);
            }
        }
        
        // Filter to only show hotels and conference rooms in the selected city
        // Handle both string and object formats for wizardData.city
        const cityName = getCityName(wizardData.city).toLowerCase();
        const filteredVenues = allVenues.filter(venue => {
            if (!venue || !venue.address || !venue.name) return false;
            
            // Check if venue is in the selected city (more flexible matching)
            const addressLower = venue.address.toLowerCase();
            const isInCity = addressLower.includes(cityName) || 
                           addressLower.includes(cityName.replace(/\s+/g, '')) ||
                           addressLower.includes(cityName.split(' ')[0]); // Match first word of city name
            
            if (!isInCity) return false;
            
            // Check if it's a hotel or conference room
            const nameLower = venue.name.toLowerCase();
            const typeLower = (venue.type || '').toLowerCase();
            const isHotel = nameLower.includes('hotel') || 
                          nameLower.includes('inn') ||
                          nameLower.includes('lodge') ||
                          typeLower.includes('hotel') || 
                          typeLower.includes('lodging');
            const isConference = nameLower.includes('conference') || 
                                nameLower.includes('meeting') || 
                                nameLower.includes('convention') ||
                                nameLower.includes('event center') ||
                                nameLower.includes('event space') ||
                                typeLower.includes('conference') ||
                                typeLower.includes('meeting') ||
                                typeLower.includes('convention');
            
            return isHotel || isConference;
        });
        
        // Remove duplicates by name
        const uniqueVenues = [];
        const seenNames = new Set();
        for (const venue of filteredVenues) {
            if (!seenNames.has(venue.name)) {
                seenNames.add(venue.name);
                uniqueVenues.push(venue);
            }
        }
        
        // Sort by rating (highest first), then by name
        uniqueVenues.sort((a, b) => {
            if (b.rating && a.rating) {
                return b.rating - a.rating;
            } else if (b.rating) {
                return 1;
            } else if (a.rating) {
                return -1;
            }
            return a.name.localeCompare(b.name);
        });
        if (uniqueVenues.length > 0) {
            // Show at least 3 venues, prefer hotels and conference rooms
            displayVenueResults(uniqueVenues.slice(0, Math.max(3, uniqueVenues.length)));
        } else {
            // If no filtered results, show all venues in the city as fallback
            console.log('No filtered results, showing all venues as fallback');
            // Handle both string and object formats for wizardData.city
            const cityNameStr = wizardData.city ? (typeof wizardData.city === 'string' ? wizardData.city : (wizardData.city.name || '')) : '';
            const cityName = cityNameStr.toLowerCase();
            const fallbackVenues = allVenues.filter(venue => {
                if (!venue || !venue.address) return false;
                const addressLower = venue.address.toLowerCase();
                return addressLower.includes(cityName) || 
                       addressLower.includes(cityName.replace(/\s+/g, '')) ||
                       addressLower.includes(cityName.split(' ')[0]);
            });
            
            if (fallbackVenues.length > 0) {
                // Remove duplicates
                const uniqueFallback = [];
                const seenNames = new Set();
                for (const venue of fallbackVenues) {
                    if (!seenNames.has(venue.name)) {
                        seenNames.add(venue.name);
                        uniqueFallback.push(venue);
                    }
                }
                
                // Sort by rating
                uniqueFallback.sort((a, b) => {
                    if (b.rating && a.rating) {
                        return b.rating - a.rating;
                    } else if (b.rating) {
                        return 1;
                    } else if (a.rating) {
                        return -1;
                    }
                    return a.name.localeCompare(b.name);
                });
                
                displayVenueResults(uniqueFallback.slice(0, Math.max(3, uniqueFallback.length)));
            } else {
                resultsList.innerHTML = `<div style="text-align: center; padding: 2rem; color: var(--text-secondary);">No venues found in ${getCityName(wizardData.city) || 'the selected city'}. Please check the browser console for details.</div>`;
            }
        }
    } catch (error) {
        console.error('Error loading initial venues:', error);
        let errorMessage = 'Error loading venue suggestions.';
        
        if (error.message) {
            if (error.message.includes('API key not configured')) {
                errorMessage = 'Google Places API key not configured.';
            } else if (error.message.includes('REQUEST_DENIED')) {
                errorMessage = 'API access denied. Check your API key and ensure Places API is enabled in Google Cloud Console.';
            } else if (error.message.includes('ZERO_RESULTS')) {
                errorMessage = 'No venues found for this city. Try searching for a specific venue type.';
            } else {
                errorMessage = error.message;
            }
        }
        
        resultsList.innerHTML = `<div style="text-align: center; padding: 2rem; color: var(--error);">
            <p><strong>${errorMessage}</strong></p>
            <p style="font-size: 0.875rem; margin-top: 0.5rem; color: var(--text-secondary);">Try searching for a specific venue type like "convention center" or "hotel".</p>
        </div>`;
    }
}

// Display venue in wizard
function displayWizardVenue() {
    const venueInfo = document.getElementById('selected-venue-info');
    if (!venueInfo || !wizardData.venue) return;
    
    venueInfo.innerHTML = `
        <div class="selected-venue-info-item">
            <label>Name:</label>
            <span>${wizardData.venue.name}</span>
        </div>
        <div class="selected-venue-info-item">
            <label>Address:</label>
            <span>${wizardData.venue.address || '-'}</span>
        </div>
        <div class="selected-venue-info-item">
            <label>Phone:</label>
            <span>${wizardData.venue.phone || '-'}</span>
        </div>
        <div class="selected-venue-info-item">
            <label>Type:</label>
            <span>${wizardData.venue.type || '-'}</span>
        </div>
        ${wizardData.venue.rating ? `
        <div class="selected-venue-info-item">
            <label>Rating:</label>
            <span>⭐ ${wizardData.venue.rating}</span>
        </div>
        ` : ''}
    `;
}

// Update wizard step 3
function updateWizardStep3() {
    displayLicenseRequirements();
    
    const licenseNotes = document.getElementById('license-notes');
    if (licenseNotes && wizardData.licenseNotes) {
        licenseNotes.value = wizardData.licenseNotes;
    }
}

// Display license requirements
function displayLicenseRequirements() {
    const licenseList = document.getElementById('license-check-list');
    if (!licenseList || !wizardData.city) return;
    
    // License requirements for gold buying events (this would ideally come from an API)
    const licenses = [
        {
            icon: '📋',
            title: 'Business License',
            description: 'Most cities require a general business license to operate.'
        },
        {
            icon: '💰',
            title: 'Precious Metals Dealer License',
            description: 'Many states require a specific license for buying and selling precious metals.'
        },
        {
            icon: '🏢',
            title: 'Zoning Permit',
            description: 'Check if the venue location is zoned for commercial gold buying activities.'
        },
        {
            icon: '📝',
            title: 'Sales Tax Permit',
            description: 'Required if you will be selling items at the event.'
        }
    ];
    
    licenseList.innerHTML = licenses.map(license => `
        <div class="license-item">
            <div class="license-item-icon">${license.icon}</div>
            <div class="license-item-content">
                <h5>${license.title}</h5>
                <p>${license.description}</p>
            </div>
        </div>
    `).join('');
}

// Update wizard step 4
function updateWizardStep4() {
    displayWizardSummary();
}

// Display wizard summary
function displayWizardSummary() {
    const summary = document.getElementById('wizard-summary');
    if (!summary) return;
    
    const opportunityScore = wizardData.researchData ? calculateProfitOpportunityScore(wizardData.researchData).toFixed(0) : '-';
    
    summary.innerHTML = `
        <div class="wizard-summary-item">
            <label>City:</label>
            <span>${wizardData.city ? `${getCityName(wizardData.city)}, ${wizardData.stateCode ? getStateName(wizardData.stateCode) : ''}` : '-'}</span>
        </div>
        <div class="wizard-summary-item">
            <label>Venue:</label>
            <span>${wizardData.venue ? wizardData.venue.name : '-'}</span>
        </div>
        <div class="wizard-summary-item">
            <label>Opportunity Score:</label>
            <span>${opportunityScore !== '-' ? `${opportunityScore}/100` : '-'}</span>
        </div>
        <div class="wizard-summary-item">
            <label>Population:</label>
            <span>${wizardData.researchData ? formatNumber(wizardData.researchData.B01001_001E || 0) : '-'}</span>
        </div>
    `;
}
// Wizard navigation
function wizardNextStep(currentStep) {
    if (currentStep === 1 && !wizardData.city) {
        alert('Please select a city first.');
        return;
    }
    if (currentStep === 2 && !wizardData.venue) {
        alert('Please select a venue first.');
        return;
    }
    if (currentStep === 3) {
        const licensesChecked = document.getElementById('licenses-checked');
        if (!licensesChecked || !licensesChecked.checked) {
            alert('Please confirm that you have checked all license requirements.');
            return;
        }
        // Save license notes
        wizardData.licenseNotes = document.getElementById('license-notes').value;
    }
    
    if (currentStep < 4) {
        showWizardStep(currentStep + 1);
    }
}

function wizardPreviousStep(currentStep) {
    if (currentStep > 1) {
        showWizardStep(currentStep - 1);
    }
}

function cancelWizard() {
    if (confirm('Are you sure you want to cancel? All progress will be lost.')) {
        closeWizard();
    }
}

function closeWizard() {
    const wizard = document.getElementById('event-planning-wizard');
    wizard.style.display = 'none';
    document.getElementById('create-event-btn').style.display = 'inline-block';
    wizardData = {
        city: null,
        researchData: null,
        venue: null,
        licenses: null,
        licenseNotes: ''
    };
}
// Add city to wizard (called from "Add to Event Planner" button)
function addToEventPlanner() {
    if (!currentResearchData) {
        alert('No research data available. Please search for a city first.');
        return;
    }
    
    // Extract city name and state from currentResearchData
    const cityName = currentResearchData.cityName;
    const stateCode = currentResearchData.stateCode;
    
    if (!cityName || !stateCode) {
        alert('City information is incomplete. Please search again.');
        return;
    }
    
    // Store in wizard data
    wizardData.city = {
        name: cityName,
        stateCode: stateCode
    };
    wizardData.researchData = { ...currentResearchData };
    
    // Start wizard if not already started
    const wizard = document.getElementById('event-planning-wizard');
    if (wizard && wizard.style.display === 'none') {
        startWizard();
    } else {
        // Update step 1 if wizard is already open
        updateWizardStep1();
    }
}
// Clear wizard city
function clearWizardCity() {
    if (!wizardData) wizardData = {};
    wizardData.city = null;
    wizardData.stateCode = null;
    wizardData.researchData = null;
    
    // Hide city selection
    const citySelectionDiv = document.getElementById('wizard-city-selection');
    if (citySelectionDiv) citySelectionDiv.style.display = 'none';
    
    // Hide results
    const resultsDiv = document.getElementById('wizard-market-research-results');
    if (resultsDiv) resultsDiv.style.display = 'none';
    
    // Disable Next button
    const nextBtn = document.getElementById('wizard-step-1-next');
    if (nextBtn) nextBtn.disabled = true;
    
    // Clear form
    const cityInput = document.getElementById('wizard-research-city');
    const stateInput = document.getElementById('wizard-research-state');
    const zipInput = document.getElementById('wizard-research-zip');
    if (cityInput) cityInput.value = '';
    if (stateInput) stateInput.value = '';
    if (zipInput) zipInput.value = '';
    
    updateWizardStep1();
}
// Search for venues using Google Places API
async function searchVenue() {
    const searchInput = document.getElementById('venue-search');
    const query = searchInput.value.trim();
    
    if (!query) {
        alert('Please enter a venue name or type.');
        return;
    }
    
    if (!wizardData.city) {
        alert('Please select a city first.');
        return;
    }
    
    // Show loading state
    const results = document.getElementById('venue-results');
    const resultsList = document.getElementById('venue-results-list');
    if (results) {
        results.style.display = 'block';
    }
    if (resultsList) {
        resultsList.innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--text-secondary);">Searching for venues...</div>';
    }
    try {
        // Search for venues using Google Places API
        const venues = await fetchVenuesFromGooglePlaces(query, wizardData.city);
        
        // Filter to only show hotels and conference rooms in the selected city
        // Handle both string and object formats for wizardData.city
        const cityName = getCityName(wizardData.city).toLowerCase();
        const filteredVenues = venues.filter(venue => {
            if (!venue || !venue.address || !venue.name) return false;
            
            // Check if venue is in the selected city (more flexible matching)
            const addressLower = venue.address.toLowerCase();
            const isInCity = addressLower.includes(cityName) || 
                           addressLower.includes(cityName.replace(/\s+/g, '')) ||
                           addressLower.includes(cityName.split(' ')[0]); // Match first word of city name
            
            if (!isInCity) return false;
            
            // Check if it's a hotel or conference room
            const nameLower = venue.name.toLowerCase();
            const typeLower = (venue.type || '').toLowerCase();
            const isHotel = nameLower.includes('hotel') || 
                          nameLower.includes('inn') ||
                          nameLower.includes('lodge') ||
                          typeLower.includes('hotel') || 
                          typeLower.includes('lodging');
            const isConference = nameLower.includes('conference') || 
                                nameLower.includes('meeting') || 
                                nameLower.includes('convention') ||
                                nameLower.includes('event center') ||
                                nameLower.includes('event space') ||
                                typeLower.includes('conference') ||
                                typeLower.includes('meeting') ||
                                typeLower.includes('convention');
            
            return isHotel || isConference;
        });
        
        if (filteredVenues.length > 0) {
            // Sort by rating (highest first)
            filteredVenues.sort((a, b) => {
                if (b.rating && a.rating) {
                    return b.rating - a.rating;
                } else if (b.rating) {
                    return 1;
                } else if (a.rating) {
                    return -1;
                }
                return a.name.localeCompare(b.name);
            });
            
            displayVenueResults(filteredVenues);
        } else {
            resultsList.innerHTML = `<div style="text-align: center; padding: 2rem; color: var(--text-secondary);">No hotels or conference rooms found in ${getCityName(wizardData.city) || 'the selected city'} matching "${query}". Try a different search term.</div>`;
        }
    } catch (error) {
        console.error('Venue search error:', error);
        let errorMessage = 'Error searching for venues.';
        
        if (error.message) {
            if (error.message.includes('REQUEST_DENIED')) {
                errorMessage = 'API access denied. Check your API key and ensure Places API is enabled in Google Cloud Console.';
            } else if (error.message.includes('ZERO_RESULTS')) {
                errorMessage = `No hotels or conference rooms found in ${getCityName(wizardData.city) || 'the selected city'}. Try a different search term.`;
            } else {
                errorMessage = error.message;
            }
        }
        
        resultsList.innerHTML = `<div style="text-align: center; padding: 2rem; color: var(--error);">
            <p><strong>${errorMessage}</strong></p>
            <p style="font-size: 0.875rem; margin-top: 0.5rem; color: var(--text-secondary);">Please check the browser console for more details.</p>
        </div>`;
    }
}

// Wait for Google Places library to load
function waitForGooglePlaces() {
    return new Promise((resolve, reject) => {
        if (typeof google !== 'undefined' && google.maps && google.maps.places) {
            resolve();
            return;
        }
        
        // Wait up to 10 seconds for library to load
        let attempts = 0;
        const maxAttempts = 100; // 10 seconds with 100ms intervals
        const interval = setInterval(() => {
            attempts++;
            if (typeof google !== 'undefined' && google.maps && google.maps.places) {
                clearInterval(interval);
                resolve();
            } else if (attempts >= maxAttempts) {
                clearInterval(interval);
                reject(new Error('Google Places JavaScript library failed to load. Please check your API key and ensure Places API is enabled in Google Cloud Console.'));
            }
        }, 100);
    });
}

// Fetch venues from Google Places API using JavaScript library
async function fetchVenuesFromGooglePlaces(query, city) {
    // Wait for library to load
    try {
        await waitForGooglePlaces();
        console.log('Google Places library loaded successfully');
    } catch (error) {
        console.error('Error waiting for Google Places library:', error);
        throw error;
    }
    
    return new Promise((resolve, reject) => {
        try {
            // Build search query: "hotel Phoenix, AZ"
            // Handle both string city name and object with name/stateCode
            let cityName, stateCode;
            if (typeof city === 'string') {
                cityName = city;
                // Try to get state code from wizardData if available
                stateCode = wizardData && wizardData.stateCode ? wizardData.stateCode : null;
            } else if (city && city.name) {
                cityName = city.name;
                stateCode = city.stateCode;
            } else {
                cityName = city || '';
                stateCode = null;
            }
            
            const locationQuery = stateCode 
                ? `${query} ${cityName}, ${getStateName(stateCode)}`
                : `${query} ${cityName}`;
            
            console.log('Searching for venues:', locationQuery);
            
            // Create a PlacesService instance with a proper div element
            const div = document.createElement('div');
            const service = new google.maps.places.PlacesService(div);
            
            // Create a request object - simplified without fields parameter which might cause issues
            const request = {
                query: locationQuery
            };
            
            // Add timeout to the search
            let searchTimeout = setTimeout(() => {
                console.error('Search timeout - no response received');
                reject(new Error('Venue search timed out. The Places API may not be enabled for your API key. Please enable Places API in Google Cloud Console.'));
            }, 10000); // 10 second timeout
            
            // Perform text search
            service.textSearch(request, (results, status) => {
                clearTimeout(searchTimeout);
                
                console.log('Google Places API status:', status);
                console.log('Results:', results);
                
                if (status === google.maps.places.PlacesServiceStatus.OK && results && results.length > 0) {
                    // Map results to our venue format
                    const venues = results.slice(0, 10).map(place => {
                        // Get formatted address
                        const address = place.formatted_address || place.vicinity || '';
                        
                        // Get phone number - try to get from place details if available
                        let phone = place.international_phone_number || place.formatted_phone_number || null;
                        
                        // Get venue type from place types (prefer specific types)
                        let type = 'Venue';
                        if (place.types && place.types.length > 0) {
                            // Filter out generic types and prefer specific ones
                            const preferredTypes = place.types.filter(t => 
                                !t.includes('establishment') && 
                                !t.includes('point_of_interest') &&
                                !t.includes('premise')
                            );
                            const typeToUse = preferredTypes.length > 0 ? preferredTypes[0] : place.types[0];
                            type = typeToUse.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
                        }
                        
                        return {
                            name: place.name,
                            address: address,
                            phone: phone,
                            type: type,
                            rating: place.rating || null,
                            placeId: place.place_id
                        };
                    });
                    
                    // Fetch phone numbers for venues that don't have them
                    Promise.all(venues.map(async (venue) => {
                        if (!venue.phone && venue.placeId) {
                            try {
                                venue.phone = await fetchPlacePhoneNumber(venue.placeId);
                            } catch (error) {
                                console.error(`Error fetching phone for ${venue.name}:`, error);
                            }
                        }
                        return venue;
                    })).then(() => {
                        console.log('Mapped venues:', venues.length);
                        resolve(venues);
                    });
                } else if (status === google.maps.places.PlacesServiceStatus.ZERO_RESULTS) {
                    console.log('No results found');
                    resolve([]); // No results found
                } else if (status === google.maps.places.PlacesServiceStatus.REQUEST_DENIED) {
                    reject(new Error('Google Places API access denied. Please enable Places API (New) in Google Cloud Console and ensure your API key has the correct permissions.'));
                } else if (status === google.maps.places.PlacesServiceStatus.INVALID_REQUEST) {
                    reject(new Error(`Invalid request: ${locationQuery}. Please check your search query.`));
                } else if (status === google.maps.places.PlacesServiceStatus.OVER_QUERY_LIMIT) {
                    reject(new Error('Google Places API quota exceeded. Please try again later.'));
                } else {
                    reject(new Error(`Google Places API error: ${status}. Please check your API key and ensure Places API is enabled.`));
                }
            });
        } catch (error) {
            console.error('Error in fetchVenuesFromGooglePlaces:', error);
            reject(error);
        }
    });
}

// Fetch phone number from Place Details API (no longer needed with JavaScript library, but keeping for reference)
async function fetchPlacePhoneNumber(placeId) {
    return new Promise((resolve, reject) => {
        if (typeof google === 'undefined' || !google.maps || !google.maps.places) {
            resolve(null);
            return;
        }
        
        const service = new google.maps.places.PlacesService(document.createElement('div'));
        
        const request = {
            placeId: placeId,
            fields: ['formatted_phone_number', 'international_phone_number']
        };
        
        service.getDetails(request, (place, status) => {
            if (status === google.maps.places.PlacesServiceStatus.OK && place) {
                resolve(place.international_phone_number || place.formatted_phone_number || null);
            } else {
                resolve(null);
            }
        });
    });
}
// Display venue search results
function displayVenueResults(venues) {
    const results = document.getElementById('venue-results');
    const resultsList = document.getElementById('venue-results-list');
    
    if (!results || !resultsList) return;
    
    if (venues.length === 0) {
        resultsList.innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--text-secondary);">No venues found. Try a different search term.</div>';
        return;
    }
    
    results.style.display = 'block';
    resultsList.innerHTML = venues.map((venue, index) => `
        <div class="venue-result-item" onclick="selectVenue(${index})">
            <div class="venue-result-header">
                <h5>${venue.name}</h5>
                ${venue.rating ? `<span class="venue-rating">⭐ ${venue.rating}</span>` : ''}
            </div>
            <div class="venue-result-details">
                <div class="venue-detail-item">
                    <span class="venue-detail-icon">📍</span>
                    <span class="venue-detail-text">${venue.address}</span>
                </div>
                <div class="venue-detail-item">
                    <span class="venue-detail-icon">📞</span>
                    <span class="venue-detail-text">${venue.phone || 'N/A'}</span>
                </div>
                <div class="venue-detail-item">
                    <span class="venue-detail-icon">🏢</span>
                    <span class="venue-detail-text">${venue.type || 'Venue'}</span>
                </div>
            </div>
        </div>
    `).join('');
    
    // Store venues for selection
    window.wizardVenues = venues;
}

// Select venue
function selectVenue(index) {
    if (!window.wizardVenues || !window.wizardVenues[index]) return;
    
    wizardData.venue = window.wizardVenues[index];
    
    // Update UI
    document.getElementById('venue-results').style.display = 'none';
    document.getElementById('venue-search').value = '';
    updateWizardStep2();
    
    // Highlight selected venue
    document.querySelectorAll('.venue-result-item').forEach(item => {
        item.classList.remove('selected');
    });
}

// Clear wizard venue
function clearWizardVenue() {
    wizardData.venue = null;
    updateWizardStep2();
}

// Update license status checkbox
function updateLicenseStatus() {
    const licensesChecked = document.getElementById('licenses-checked');
    const nextBtn = document.getElementById('wizard-step-3-next');
    
    if (nextBtn) {
        nextBtn.disabled = !licensesChecked || !licensesChecked.checked;
    }
}
// Save wizard event
function saveWizardEvent(e) {
    e.preventDefault();
    
    const eventName = document.getElementById('wizard-event-name').value.trim();
    const startDate = document.getElementById('wizard-start-date').value;
    const endDate = document.getElementById('wizard-end-date').value;
    const notes = document.getElementById('wizard-notes').value.trim();
    const estimatedSpend = parseFloat(document.getElementById('wizard-estimated-spend').value) || 0;
    const estimatedROI = parseFloat(document.getElementById('wizard-estimated-roi').value) || 0;
    const status = document.getElementById('wizard-status').value;
    
    if (!eventName || !startDate) {
        alert('Please enter event name and start date');
        return;
    }
    
    if (!wizardData.city || !wizardData.venue) {
        alert('Please complete all wizard steps');
        return;
    }
    
    const events = getPlannedEvents();
    
    const newEvent = {
        id: Date.now().toString(),
        name: eventName,
        startDate,
        endDate,
        venue: wizardData.venue.name,
        venueAddress: wizardData.venue.address,
        venuePhone: wizardData.venue.phone,
        notes,
        estimatedSpend,
        estimatedROI,
        status,
        city: wizardData.city.name,
        stateCode: wizardData.city.stateCode,
        researchData: wizardData.researchData,
        licenseNotes: wizardData.licenseNotes,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    
    events.push(newEvent);
    savePlannedEvents(events);
    loadEventList();
    
    // Close wizard
    closeWizard();
    
    // If status is 'active', also create in main event system
    if (status === 'active') {
        linkEventToMainSystem(newEvent).then(() => {
            console.log('Planned event linked to main system');
        }).catch(error => {
            console.error('Error linking planned event:', error);
        });
    }
    
    alert('Event saved successfully!');
}

// Make wizard functions globally accessible
window.startWizard = startWizard;
window.wizardNextStep = wizardNextStep;
window.wizardPreviousStep = wizardPreviousStep;
window.cancelWizard = cancelWizard;
window.addToEventPlanner = addToEventPlanner;
window.clearWizardCity = clearWizardCity;
window.searchVenue = searchVenue;
window.selectVenue = selectVenue;
window.clearWizardVenue = clearWizardVenue;
window.updateLicenseStatus = updateLicenseStatus;
window.saveWizardEvent = saveWizardEvent;

// localStorage functions for planned events
function getPlannedEvents() {
    const stored = localStorage.getItem('plannedEvents');
    return stored ? JSON.parse(stored) : [];
}

function savePlannedEvents(events) {
    localStorage.setItem('plannedEvents', JSON.stringify(events));
}

// Make functions globally accessible
window.addToEventPlanner = addToEventPlanner;
window.closeEventPlannerModal = closeEventPlannerModal;
window.deletePlannedEvent = deletePlannedEvent;
window.editPlannedEvent = editPlannedEvent;
window.viewEventInDashboard = viewEventInDashboard;

function showMarketResearchError(message) {
    const errorEl = document.getElementById('market-research-error');
    errorEl.textContent = message;
    errorEl.style.display = 'block';
}

function clearMarketResearch() {
    document.getElementById('market-research-results').style.display = 'none';
    document.getElementById('market-research-error').style.display = 'none';
    document.getElementById('research-city').value = '';
    document.getElementById('research-state').value = '';
}

function getStateName(stateCode) {
    const states = {
        '01': 'Alabama', '02': 'Alaska', '04': 'Arizona', '05': 'Arkansas',
        '06': 'California', '08': 'Colorado', '09': 'Connecticut', '10': 'Delaware',
        '11': 'District of Columbia', '12': 'Florida', '13': 'Georgia', '15': 'Hawaii',
        '16': 'Idaho', '17': 'Illinois', '18': 'Indiana', '19': 'Iowa',
        '20': 'Kansas', '21': 'Kentucky', '22': 'Louisiana', '23': 'Maine',
        '24': 'Maryland', '25': 'Massachusetts', '26': 'Michigan', '27': 'Minnesota',
        '28': 'Mississippi', '29': 'Missouri', '30': 'Montana', '31': 'Nebraska',
        '32': 'Nevada', '33': 'New Hampshire', '34': 'New Jersey', '35': 'New Mexico',
        '36': 'New York', '37': 'North Carolina', '38': 'North Dakota', '39': 'Ohio',
        '40': 'Oklahoma', '41': 'Oregon', '42': 'Pennsylvania', '44': 'Rhode Island',
        '45': 'South Carolina', '46': 'South Dakota', '47': 'Tennessee', '48': 'Texas',
        '49': 'Utah', '50': 'Vermont', '51': 'Virginia', '53': 'Washington',
        '54': 'West Virginia', '55': 'Wisconsin', '56': 'Wyoming'
    };
    return states[stateCode] || stateCode;
}

function formatNumber(num) {
    if (num === null || num === undefined) return '-';
    return new Intl.NumberFormat('en-US').format(num);
}

// Make clearMarketResearch globally accessible
window.clearMarketResearch = clearMarketResearch;

// Close dropdowns when clicking outside
document.addEventListener('click', (e) => {
    // Don't close if clicking on dropdown toggle or item
    if (e.target.closest('.dropdown-toggle') || e.target.closest('.dropdown-item')) {
        return;
    }
    
    // Close all dropdowns if clicking outside
    if (!e.target.closest('.nav-dropdown')) {
        document.querySelectorAll('.nav-dropdown').forEach(dd => {
            dd.classList.remove('active');
            // Also clear inline styles
            const menu = dd.querySelector('.dropdown-menu');
            if (menu) {
                menu.style.visibility = '';
                menu.style.opacity = '';
                menu.style.display = '';
            }
        });
    }
});

// Close dropdowns when mouse leaves the dropdown area
function setupDropdownMouseLeave() {
    document.querySelectorAll('.nav-dropdown').forEach(dropdown => {
        // Check if already set up
        if (dropdown.dataset.mouseleaveSetup) {
            return;
        }
        
        // Add mouseleave listener with delay to allow moving to menu
        let closeTimeout;
        
        // Listen for mouseleave on both dropdown and menu
        const handleMouseLeave = (e) => {
            // Check if mouse is moving to a child element
            const relatedTarget = e.relatedTarget;
            if (relatedTarget && (dropdown.contains(relatedTarget) || dropdown.querySelector('.dropdown-menu')?.contains(relatedTarget))) {
                return; // Mouse is moving within dropdown area, don't close
            }
            
            // Clear any existing timeout
            if (closeTimeout) {
                clearTimeout(closeTimeout);
            }
            
            // Small delay to allow mouse to move to menu
            closeTimeout = setTimeout(() => {
                // Double check mouse is still outside
                const isMouseOver = dropdown.matches(':hover') || dropdown.querySelector('.dropdown-menu')?.matches(':hover');
                if (!isMouseOver) {
                    dropdown.classList.remove('active');
                    // Clear inline styles
                    const menu = dropdown.querySelector('.dropdown-menu');
                    if (menu) {
                        menu.style.visibility = '';
                        menu.style.opacity = '';
                        menu.style.display = '';
                    }
                }
            }, 200); // 200ms delay to allow moving to menu
        };
        
        dropdown.addEventListener('mouseleave', handleMouseLeave);
        
        // Also listen on the menu itself
        const menu = dropdown.querySelector('.dropdown-menu');
        if (menu) {
            menu.addEventListener('mouseleave', handleMouseLeave);
        }
        
        // Cancel close if mouse enters dropdown again
        dropdown.addEventListener('mouseenter', () => {
            if (closeTimeout) {
                clearTimeout(closeTimeout);
                closeTimeout = null;
            }
        });
        
        if (menu) {
            menu.addEventListener('mouseenter', () => {
                if (closeTimeout) {
                    clearTimeout(closeTimeout);
                    closeTimeout = null;
                }
            });
        }
        
        dropdown.dataset.mouseleaveSetup = 'true';
    });
}

// Set up on DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupDropdownMouseLeave);
} else {
    setupDropdownMouseLeave();
}

// Also set up after a delay to ensure it works
setTimeout(setupDropdownMouseLeave, 500);

// ============================================
// HOUSE CALLS ROUTE PLANNER
// ============================================

// Route planner state
if (typeof CALENDLY_API_BASE === 'undefined') {
    var CALENDLY_API_BASE = 'https://api.calendly.com';
}

if (typeof CALENDLY_API_TOKEN === 'undefined') {
    var CALENDLY_API_TOKEN = (typeof window !== 'undefined' && window.CALENDLY_API_TOKEN) ? window.CALENDLY_API_TOKEN : '';
}

const CALENDLY_CACHE_STORAGE_KEY = 'calendlyAppointments';
const CALENDLY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let calendlyAppointmentsCache = [];
let calendlyLastFetchedAt = 0;

let routePlannerState = {
    stops: [],
    map: null,
    directionsService: null,
    directionsRenderer: null,
    autocomplete: null,
    markers: [],
    isGoogleMapsLoaded: false,
    appointments: [],
    selectedAppointments: []
};

function normalizeCalendlyEvent(event) {
    if (!event) return null;
    
    const startTime = event.start_time || event.startTime || event.startDateTime;
    const endTime = event.end_time || event.endTime || event.endDateTime || startTime;
    const uri = event.uri || event.id || `cal-${Date.now()}`;
    const invitees = Array.isArray(event.invitees) ? event.invitees : (event.invitee ? [event.invitee] : []);
    const location = event.location || (event.location_type ? { location: event.location_type } : {});
    
    return {
        ...event,
        uri,
        start_time: startTime,
        end_time: endTime,
        invitees,
        location
    };
}

function storeCalendlyAppointments(appointments) {
    calendlyAppointmentsCache = appointments;
    calendlyLastFetchedAt = Date.now();
    try {
        localStorage.setItem(CALENDLY_CACHE_STORAGE_KEY, JSON.stringify(appointments));
    } catch (error) {
        console.warn('Unable to cache Calendly appointments:', error);
    }
}

function hydrateCalendlyAppointmentsFromStorage() {
    try {
        const stored = localStorage.getItem(CALENDLY_CACHE_STORAGE_KEY);
        if (stored) {
            const parsed = JSON.parse(stored);
            if (Array.isArray(parsed)) {
                calendlyAppointmentsCache = parsed.map(normalizeCalendlyEvent).filter(Boolean);
            }
        }
    } catch (error) {
        console.warn('Unable to load cached Calendly appointments:', error);
        calendlyAppointmentsCache = [];
    }
}

async function fetchCalendlyAppointmentsFromApi() {
    if (!CALENDLY_API_TOKEN) {
        return [];
    }
    
    try {
        const userResponse = await fetch(`${CALENDLY_API_BASE}/users/me`, {
            headers: {
                'Authorization': `Bearer ${CALENDLY_API_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (!userResponse.ok) {
            throw new Error(`Calendly user lookup failed (${userResponse.status})`);
        }
        
        const userData = await userResponse.json();
        const userUri = userData?.resource?.uri;
        if (!userUri) {
            throw new Error('Calendly user URI not returned');
        }
        
        const eventsResponse = await fetch(`${CALENDLY_API_BASE}/scheduled_events?user=${encodeURIComponent(userUri)}&status=active&count=100&sort=start_time:asc`, {
            headers: {
                'Authorization': `Bearer ${CALENDLY_API_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (!eventsResponse.ok) {
            throw new Error(`Calendly events fetch failed (${eventsResponse.status})`);
        }
        
        const eventsData = await eventsResponse.json();
        const events = Array.isArray(eventsData?.collection) ? eventsData.collection : [];
        
        const appointmentsWithInvitees = await Promise.all(events.map(async (event) => {
            try {
                const eventId = event?.uri ? event.uri.split('/').pop() : null;
                if (!eventId) {
                    return normalizeCalendlyEvent(event);
                }
                
                const inviteesResponse = await fetch(`${CALENDLY_API_BASE}/scheduled_events/${eventId}/invitees`, {
                    headers: {
                        'Authorization': `Bearer ${CALENDLY_API_TOKEN}`,
                        'Content-Type': 'application/json'
                    }
                });
                
                let invitees = [];
                if (inviteesResponse.ok) {
                    const inviteesData = await inviteesResponse.json();
                    invitees = Array.isArray(inviteesData?.collection) ? inviteesData.collection : [];
                }
                
                return normalizeCalendlyEvent({
                    ...event,
                    invitees
                });
            } catch (error) {
                console.warn('Unable to fetch Calendly invitees for event', event?.uri, error);
                return normalizeCalendlyEvent(event);
            }
        }));
        
        const now = Date.now();
        return appointmentsWithInvitees.filter(apt => {
            const start = apt?.start_time ? new Date(apt.start_time).getTime() : 0;
            return start >= now;
        }).map(normalizeCalendlyEvent).filter(Boolean);
    } catch (error) {
        console.error('Error fetching Calendly appointments:', error);
        return [];
    }
}

async function loadCalendlyAppointments(forceRefresh = false) {
    if (!forceRefresh) {
        const withinTtl = calendlyAppointmentsCache.length > 0 && (Date.now() - calendlyLastFetchedAt) < CALENDLY_CACHE_TTL_MS;
        if (withinTtl) {
            renderTodayAppointments();
            renderAppointmentsCalendar();
            return calendlyAppointmentsCache;
        }
    }
    
    if (calendlyAppointmentsCache.length === 0) {
        hydrateCalendlyAppointmentsFromStorage();
        if (calendlyAppointmentsCache.length > 0 && !forceRefresh) {
            renderTodayAppointments();
            renderAppointmentsCalendar();
            return calendlyAppointmentsCache;
        }
    }
    
    const appointments = await fetchCalendlyAppointmentsFromApi();
    
    if (appointments.length > 0) {
        storeCalendlyAppointments(appointments);
    }
    
    renderTodayAppointments();
    renderAppointmentsCalendar();
    return calendlyAppointmentsCache;
}

function getCombinedAppointments() {
    const combinedMap = new Map();
    
    const addAppointment = (appointment, source) => {
        if (!appointment) return;
        const normalized = normalizeCalendlyEvent({
            ...appointment,
            source: appointment.source || source
        });
        if (!normalized || !normalized.uri) return;
        combinedMap.set(normalized.uri, normalized);
    };
    
    calendlyAppointmentsCache.forEach(apt => addAppointment(apt, 'calendly'));
    if (Array.isArray(routePlannerState.appointments)) {
        routePlannerState.appointments.forEach(apt => addAppointment(apt, 'local'));
    }
    
    const combined = Array.from(combinedMap.values());
    combined.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
    return combined;
}

// Initialize Google Maps (called by script callback)
window.initGoogleMaps = function() {
    routePlannerState.isGoogleMapsLoaded = true;
    if (document.getElementById('appointments')?.classList.contains('active')) {
        initializeRoutePlanner();
    }
};
// Initialize route planner
function initializeRoutePlanner() {
    if (!routePlannerState.isGoogleMapsLoaded) {
        console.log('Google Maps not loaded yet');
        return;
    }
    
    // Initialize map
    const mapContainer = document.getElementById('route-map');
    if (!mapContainer) return;
    
    if (!routePlannerState.map) {
        routePlannerState.map = new google.maps.Map(mapContainer, {
            center: { lat: 33.4484, lng: -112.0740 }, // Default to Phoenix, AZ
            zoom: 10,
            mapTypeControl: true,
            streetViewControl: true
        });
        
        // Initialize directions service
        routePlannerState.directionsService = new google.maps.DirectionsService();
        routePlannerState.directionsRenderer = new google.maps.DirectionsRenderer({
            map: routePlannerState.map,
            suppressMarkers: false
        });
    }
    
    // Initialize address autocomplete
    const addressInput = document.getElementById('stop-address-input');
    if (addressInput && !routePlannerState.autocomplete) {
        routePlannerState.autocomplete = new google.maps.places.Autocomplete(addressInput, {
            fields: ['formatted_address', 'geometry', 'name'],
            types: ['address', 'establishment']
        });
        
        // Handle autocomplete selection
        routePlannerState.autocomplete.addListener('place_changed', () => {
            const place = routePlannerState.autocomplete.getPlace();
            if (place.geometry) {
                // Place is selected, ready to add
                console.log('Place selected:', place);
            }
        });
    }
    
    // Load saved stops
    loadSavedStops();
    renderStopsList();
    
    // Load local appointments
    loadLocalAppointments();
    
    // Set up event listeners
    setupRoutePlannerListeners();
    
    // Load appointments if available
    loadAppointmentsForRoute();
    
    // Update calendar with all appointments (Calendly + local, deduplicated)
    setTimeout(() => {
        const combinedAppointments = getCombinedAppointments();
        renderAppointmentsCalendar(combinedAppointments);
        
        // Automatically add today's appointments to route
        autoAddTodayAppointmentsToRoute(combinedAppointments);
    }, 500);
}
// Set up event listeners for route planner
function setupRoutePlannerListeners() {
    // Add stop button
    const addStopBtn = document.getElementById('add-stop-btn');
    if (addStopBtn) {
        addStopBtn.addEventListener('click', addStop);
    }
    
    // Optimize route button
    const optimizeBtn = document.getElementById('optimize-route-btn');
    if (optimizeBtn) {
        optimizeBtn.addEventListener('click', optimizeRoute);
    }
    
    // Clear all button
    const clearBtn = document.getElementById('clear-all-btn');
    if (clearBtn) {
        clearBtn.addEventListener('click', clearAllStops);
    }
    
    // Enter key on address input
    const addressInput = document.getElementById('stop-address-input');
    if (addressInput) {
        addressInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                addStop();
            }
        });
    }
    
    // Customer search autocomplete
    setupCustomerAutocomplete();
    
    // Load appointments button
    const loadAppointmentsBtn = document.getElementById('load-appointments-btn');
    if (loadAppointmentsBtn) {
        loadAppointmentsBtn.addEventListener('click', loadAppointmentsForRoute);
    }
    
    // Add appointments to route button
    const addAppointmentsBtn = document.getElementById('add-appointments-to-route-btn');
    if (addAppointmentsBtn) {
        addAppointmentsBtn.addEventListener('click', addSelectedAppointmentsToRoute);
    }
    
    // Create appointment button
    const createAppointmentBtn = document.getElementById('create-appointment-btn');
    if (createAppointmentBtn) {
        createAppointmentBtn.addEventListener('click', openCreateAppointmentModal);
    }
    
    // Create appointment form
    const createAppointmentForm = document.getElementById('create-appointment-form');
    if (createAppointmentForm) {
        createAppointmentForm.addEventListener('submit', handleCreateAppointment);
    }
    
    // Check for conflicts when date/time changes
    const appointmentDateInput = document.getElementById('appointment-date');
    const appointmentTimeInput = document.getElementById('appointment-start-time');
    const appointmentDurationInput = document.getElementById('appointment-duration');
    
    if (appointmentDateInput) {
        appointmentDateInput.addEventListener('change', checkAppointmentConflicts);
    }
    if (appointmentTimeInput) {
        appointmentTimeInput.addEventListener('change', checkAppointmentConflicts);
    }
    if (appointmentDurationInput) {
        appointmentDurationInput.addEventListener('change', checkAppointmentConflicts);
    }
    
    // Customer autocomplete for appointment form
    setupAppointmentCustomerAutocomplete();
}

// Setup customer autocomplete for address input
function setupCustomerAutocomplete() {
    const addressInput = document.getElementById('stop-address-input');
    const autocompleteDiv = document.getElementById('address-autocomplete');
    
    if (!addressInput || !autocompleteDiv) return;
    
    let autocompleteTimeout;
    
    addressInput.addEventListener('input', (e) => {
        const query = e.target.value.trim();
        
        clearTimeout(autocompleteTimeout);
        
        if (query.length < 2) {
            autocompleteDiv.innerHTML = '';
            autocompleteDiv.style.display = 'none';
            return;
        }
        
        autocompleteTimeout = setTimeout(() => {
            // Search customers
            const customers = getCustomersData();
            const matches = Object.values(customers).filter(customer => {
                const name = (customer.name || '').toLowerCase();
                const phone = (customer.phone || '').replace(/\D/g, '');
                const queryLower = query.toLowerCase();
                const queryDigits = query.replace(/\D/g, '');
                
                return name.includes(queryLower) || 
                       phone.includes(queryDigits) ||
                       (customer.address && customer.address.toLowerCase().includes(queryLower));
            }).slice(0, 5);
            
            if (matches.length > 0) {
                let html = '';
                matches.forEach(customer => {
                    const address = customer.address || 'No address on file';
                    html += `
                        <div class="autocomplete-item" onclick="selectCustomerForRoute('${customer.name.replace(/'/g, "\\'")}', '${address.replace(/'/g, "\\'")}')">
                            <div class="autocomplete-item-name">${escapeHtml(customer.name)}</div>
                            <div class="autocomplete-item-detail">${escapeHtml(address)}</div>
                        </div>
                    `;
                });
                autocompleteDiv.innerHTML = html;
                autocompleteDiv.style.display = 'block';
            } else {
                autocompleteDiv.innerHTML = '';
                autocompleteDiv.style.display = 'none';
            }
        }, 300);
    });
    
    // Hide autocomplete when clicking outside
    document.addEventListener('click', (e) => {
        if (!addressInput.contains(e.target) && !autocompleteDiv.contains(e.target)) {
            autocompleteDiv.style.display = 'none';
        }
    });
}

// Select customer for route
window.selectCustomerForRoute = function(name, address) {
    const addressInput = document.getElementById('stop-address-input');
    const notesInput = document.getElementById('stop-notes');
    const autocompleteDiv = document.getElementById('address-autocomplete');
    
    if (addressInput) {
        addressInput.value = address;
    }
    if (notesInput) {
        notesInput.value = `Customer: ${name}`;
    }
    if (autocompleteDiv) {
        autocompleteDiv.style.display = 'none';
    }
};

// Add stop to route
function addStop() {
    const addressInput = document.getElementById('stop-address-input');
    const notesInput = document.getElementById('stop-notes');
    
    if (!addressInput || !addressInput.value.trim()) {
        alert('Please enter an address');
        return;
    }
    
    const address = addressInput.value.trim();
    const notes = notesInput ? notesInput.value.trim() : '';
    
    // Geocode the address to get coordinates
    const geocoder = new google.maps.Geocoder();
    geocoder.geocode({ address: address }, (results, status) => {
        if (status === 'OK' && results[0]) {
            const location = results[0].geometry.location;
            const formattedAddress = results[0].formatted_address;
            
            const stop = {
                id: Date.now().toString(),
                address: formattedAddress,
                originalAddress: address,
                notes: notes,
                lat: location.lat(),
                lng: location.lng(),
                order: routePlannerState.stops.length
            };
            
            routePlannerState.stops.push(stop);
            saveStops();
            renderStopsList();
            updateMapMarkers();
            
            // Clear inputs
            addressInput.value = '';
            if (notesInput) notesInput.value = '';
            if (routePlannerState.autocomplete) {
                routePlannerState.autocomplete.set('place', null);
            }
            
            // Enable optimize button if we have 2+ stops
            const optimizeBtn = document.getElementById('optimize-route-btn');
            if (optimizeBtn) {
                optimizeBtn.disabled = routePlannerState.stops.length < 2;
            }
            
            // Auto-calculate route if we have 2+ stops
            if (routePlannerState.stops.length >= 2) {
                calculateRoute();
            }
        } else {
            alert('Could not find that address. Please try a more specific address.');
        }
    });
}
// Render stops list
function renderStopsList() {
    const stopsList = document.getElementById('stops-list');
    const stopsCount = document.getElementById('stops-count');
    
    if (!stopsList) return;
    
    if (routePlannerState.stops.length === 0) {
        stopsList.innerHTML = '<div class="empty-message">No stops added yet. Add addresses above to start planning your route.</div>';
        if (stopsCount) stopsCount.textContent = '0';
        return;
    }
    
    if (stopsCount) stopsCount.textContent = routePlannerState.stops.length;
    
    let html = '';
    routePlannerState.stops.forEach((stop, index) => {
        html += `
            <div class="stop-item" data-stop-id="${stop.id}">
                <div class="stop-number">${index + 1}</div>
                <div class="stop-details">
                    <div class="stop-address">${escapeHtml(stop.address)}</div>
                    ${stop.notes ? `<div class="stop-notes">${escapeHtml(stop.notes)}</div>` : ''}
                </div>
                <div class="stop-actions">
                    <button class="btn-icon" onclick="moveStopUp('${stop.id}')" title="Move Up" ${index === 0 ? 'disabled' : ''}>↑</button>
                    <button class="btn-icon" onclick="moveStopDown('${stop.id}')" title="Move Down" ${index === routePlannerState.stops.length - 1 ? 'disabled' : ''}>↓</button>
                    <button class="btn-icon btn-danger" onclick="removeStop('${stop.id}')" title="Remove">✕</button>
                </div>
            </div>
        `;
    });
    
    stopsList.innerHTML = html;
}
// Update map markers
function updateMapMarkers() {
    if (!routePlannerState.map) return;
    
    // Clear existing markers
    if (routePlannerState.markers) {
        routePlannerState.markers.forEach(marker => marker.setMap(null));
    }
    routePlannerState.markers = [];
    
    // Add markers for each stop
    routePlannerState.stops.forEach((stop, index) => {
        const marker = new google.maps.Marker({
            position: { lat: stop.lat, lng: stop.lng },
            map: routePlannerState.map,
            label: {
                text: (index + 1).toString(),
                color: '#ffffff',
                fontSize: '14px',
                fontWeight: 'bold'
            },
            title: stop.address
        });
        
        routePlannerState.markers.push(marker);
    });
    
    // Fit map to show all markers
    if (routePlannerState.stops.length > 0) {
        const bounds = new google.maps.LatLngBounds();
        routePlannerState.stops.forEach(stop => {
            bounds.extend({ lat: stop.lat, lng: stop.lng });
        });
        routePlannerState.map.fitBounds(bounds);
    }
}
// Optimize route using nearest neighbor algorithm
function optimizeRoute() {
    if (routePlannerState.stops.length < 2) {
        alert('Need at least 2 stops to optimize route');
        return;
    }
    
    // Simple optimization: use nearest neighbor algorithm
    const optimized = [];
    const remaining = [...routePlannerState.stops];
    
    // Start with first stop
    let current = remaining.shift();
    optimized.push(current);
    
    // Find nearest neighbor for each remaining stop
    while (remaining.length > 0) {
        let nearestIndex = 0;
        let nearestDistance = getDistance(current, remaining[0]);
        
        for (let i = 1; i < remaining.length; i++) {
            const distance = getDistance(current, remaining[i]);
            if (distance < nearestDistance) {
                nearestDistance = distance;
                nearestIndex = i;
            }
        }
        
        current = remaining.splice(nearestIndex, 1)[0];
        optimized.push(current);
    }
    
    // Update stops order
    routePlannerState.stops = optimized.map((stop, index) => ({
        ...stop,
        order: index
    }));
    
    saveStops();
    renderStopsList();
    calculateRoute();
}

// Calculate distance between two stops (Haversine formula)
function getDistance(stop1, stop2) {
    const R = 6371; // Earth's radius in km
    const dLat = (stop2.lat - stop1.lat) * Math.PI / 180;
    const dLon = (stop2.lng - stop1.lng) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(stop1.lat * Math.PI / 180) * Math.cos(stop2.lat * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}
// Calculate and display route
function calculateRoute() {
    if (routePlannerState.stops.length < 2) {
        return;
    }
    
    if (!routePlannerState.directionsService || !routePlannerState.directionsRenderer) {
        return;
    }
    
    // Build waypoints (all stops except first and last)
    const waypoints = routePlannerState.stops.slice(1, -1).map(stop => ({
        location: { lat: stop.lat, lng: stop.lng },
        stopover: true
    }));
    
    const request = {
        origin: { lat: routePlannerState.stops[0].lat, lng: routePlannerState.stops[0].lng },
        destination: { lat: routePlannerState.stops[routePlannerState.stops.length - 1].lat, lng: routePlannerState.stops[routePlannerState.stops.length - 1].lng },
        waypoints: waypoints,
        optimizeWaypoints: false, // We're doing our own optimization
        travelMode: google.maps.TravelMode.DRIVING
    };
    
    routePlannerState.directionsService.route(request, (result, status) => {
        if (status === 'OK') {
            routePlannerState.directionsRenderer.setDirections(result);
            
            // Display directions
            displayDirections(result);
            
            // Update summary
            updateRouteSummary(result);
        } else {
            console.error('Directions request failed:', status);
            alert('Could not calculate route. Please check your stops.');
        }
    });
}

// Display directions
function displayDirections(result) {
    const directionsPanel = document.getElementById('directions-panel');
    const directionsSection = document.getElementById('route-directions');
    
    if (!directionsPanel || !directionsSection) return;
    
    let html = '';
    const route = result.routes[0];
    
    route.legs.forEach((leg, index) => {
        html += `
            <div class="direction-leg">
                <h5>Stop ${index + 1} to Stop ${index + 2}</h5>
                <div class="leg-info">
                    <span>${leg.distance.text}</span> • <span>${leg.duration.text}</span>
                </div>
                <ol class="direction-steps">
        `;
        
        leg.steps.forEach(step => {
            html += `<li>${step.instructions}</li>`;
        });
        
        html += `
                </ol>
            </div>
        `;
    });
    
    directionsPanel.innerHTML = html;
    directionsSection.style.display = 'block';
}

// Update route summary
function updateRouteSummary(result) {
    const summarySection = document.getElementById('route-summary');
    const totalDistanceEl = document.getElementById('total-distance');
    const totalTimeEl = document.getElementById('total-time');
    const summaryStopsCountEl = document.getElementById('summary-stops-count');
    
    if (!summarySection) return;
    
    const route = result.routes[0];
    let totalDistance = 0;
    let totalDuration = 0;
    
    route.legs.forEach(leg => {
        totalDistance += leg.distance.value; // in meters
        totalDuration += leg.duration.value; // in seconds
    });
    
    // Convert to readable format
    const distanceKm = (totalDistance / 1000).toFixed(1);
    const distanceMiles = (totalDistance / 1609.34).toFixed(1);
    const hours = Math.floor(totalDuration / 3600);
    const minutes = Math.floor((totalDuration % 3600) / 60);
    
    if (totalDistanceEl) {
        totalDistanceEl.textContent = `${distanceMiles} mi (${distanceKm} km)`;
    }
    if (totalTimeEl) {
        totalTimeEl.textContent = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
    }
    if (summaryStopsCountEl) {
        summaryStopsCountEl.textContent = routePlannerState.stops.length;
    }
    
    summarySection.style.display = 'block';
}

// Move stop up
window.moveStopUp = function(stopId) {
    const index = routePlannerState.stops.findIndex(s => s.id === stopId);
    if (index > 0) {
        [routePlannerState.stops[index], routePlannerState.stops[index - 1]] = 
        [routePlannerState.stops[index - 1], routePlannerState.stops[index]];
        saveStops();
        renderStopsList();
        calculateRoute();
    }
};

// Move stop down
window.moveStopDown = function(stopId) {
    const index = routePlannerState.stops.findIndex(s => s.id === stopId);
    if (index < routePlannerState.stops.length - 1) {
        [routePlannerState.stops[index], routePlannerState.stops[index + 1]] = 
        [routePlannerState.stops[index + 1], routePlannerState.stops[index]];
        saveStops();
        renderStopsList();
        calculateRoute();
    }
};

// Remove stop
window.removeStop = function(stopId) {
    routePlannerState.stops = routePlannerState.stops.filter(s => s.id !== stopId);
    saveStops();
    renderStopsList();
    updateMapMarkers();
    
    const optimizeBtn = document.getElementById('optimize-route-btn');
    if (optimizeBtn) {
        optimizeBtn.disabled = routePlannerState.stops.length < 2;
    }
    
    if (routePlannerState.stops.length >= 2) {
        calculateRoute();
    } else {
        if (routePlannerState.directionsRenderer) {
            routePlannerState.directionsRenderer.setDirections({ routes: [] });
        }
        document.getElementById('route-directions').style.display = 'none';
        document.getElementById('route-summary').style.display = 'none';
    }
};

// Clear all stops
function clearAllStops() {
    if (!confirm('Are you sure you want to clear all stops?')) {
        return;
    }
    
    routePlannerState.stops = [];
    saveStops();
    renderStopsList();
    updateMapMarkers();
    
    if (routePlannerState.directionsRenderer) {
        routePlannerState.directionsRenderer.setDirections({ routes: [] });
    }
    
    document.getElementById('route-directions').style.display = 'none';
    document.getElementById('route-summary').style.display = 'none';
    
    const optimizeBtn = document.getElementById('optimize-route-btn');
    if (optimizeBtn) {
        optimizeBtn.disabled = true;
    }
}

// Save stops to localStorage
function saveStops() {
    localStorage.setItem('routePlannerStops', JSON.stringify(routePlannerState.stops));
}
// Load stops from localStorage
function loadSavedStops() {
    const saved = localStorage.getItem('routePlannerStops');
    if (saved) {
        try {
            routePlannerState.stops = JSON.parse(saved);
            if (routePlannerState.stops.length >= 2) {
                calculateRoute();
            }
        } catch (e) {
            console.error('Error loading saved stops:', e);
        }
    }
}

// Get customers data
function getCustomersData() {
    return JSON.parse(localStorage.getItem('customersData') || '{}');
}

// Escape HTML helper
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
// Load appointments for route planner
async function loadAppointmentsForRoute() {
    try {
        // Load local appointments first
        loadLocalAppointments();
        
        // Use the existing Calendly integration
        if (typeof loadCalendlyAppointments === 'function') {
            // First load appointments
            await loadCalendlyAppointments();
            
            // Don't merge Calendly appointments into routePlannerState.appointments
            // They should stay separate - routePlannerState.appointments is only for locally created ones
            // We'll combine them when rendering the calendar
            
            // Sort by start time
            routePlannerState.appointments.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
            
            // Then render them in the route planner
            renderAppointmentsForRoute();
            
            // Also update calendar (combine with local appointments, deduplicated)
            const combinedAppointments = getCombinedAppointments();
            renderAppointmentsCalendar(combinedAppointments);
        } else {
            // Fallback: fetch directly
            const userResponse = await fetch(`${CALENDLY_API_BASE}/users/me`, {
                headers: {
                    'Authorization': `Bearer ${CALENDLY_API_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            });
            
            if (!userResponse.ok) {
                throw new Error('Failed to get user info');
            }
            
            const userData = await userResponse.json();
            const userUri = userData.resource.uri;
            
            const eventsResponse = await fetch(`${CALENDLY_API_BASE}/scheduled_events?user=${encodeURIComponent(userUri)}&count=100&sort=start_time:asc`, {
                headers: {
                    'Authorization': `Bearer ${CALENDLY_API_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            });
            if (eventsResponse.ok) {
                const eventsData = await eventsResponse.json();
                const events = eventsData.collection || [];
                
                // Get invitee details
                const appointmentsWithDetails = await Promise.all(
                    events.map(async (event) => {
                        try {
                            const inviteesResponse = await fetch(`${CALENDLY_API_BASE}/scheduled_events/${event.uri.split('/').pop()}/invitees`, {
                                headers: {
                                    'Authorization': `Bearer ${CALENDLY_API_TOKEN}`,
                                    'Content-Type': 'application/json'
                                }
                            });
                            
                            let invitees = [];
                            if (inviteesResponse.ok) {
                                const inviteesData = await inviteesResponse.json();
                                invitees = inviteesData.collection || [];
                            }
                            
                            return {
                                ...event,
                                invitees: invitees
                            };
                        } catch (error) {
                            return { ...event, invitees: [] };
                        }
                    })
                );
                
                // Filter to upcoming appointments
                const now = new Date();
                const upcomingAppts = appointmentsWithDetails.filter(apt => {
                    const startTime = new Date(apt.start_time);
                    return startTime >= now;
                });
                
                // Don't merge Calendly appointments into routePlannerState.appointments
                // They should stay separate - routePlannerState.appointments is only for locally created ones
                // We'll combine them when rendering the calendar
                
                // Sort by start time
                routePlannerState.appointments.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
                
                renderAppointmentsForRoute();
                
                // Also update calendar (combine with Calendly appointments, deduplicated)
                const combinedAppointments = getCombinedAppointments();
                renderAppointmentsCalendar(combinedAppointments);
                
                // Automatically add today's appointments to route
                autoAddTodayAppointmentsToRoute(combinedAppointments);
            }
        }
    } catch (error) {
        console.error('Error loading appointments:', error);
        alert('Failed to load appointments. Please try again.');
    }
}
// Render appointments for route planner
function renderAppointmentsForRoute() {
    const appointmentsList = document.getElementById('appointments-route-list');
    const addToRouteBtn = document.getElementById('add-appointments-to-route-btn');
    
    if (!appointmentsList) return;
    
    if (routePlannerState.appointments.length === 0) {
        appointmentsList.innerHTML = '<div class="empty-message">No upcoming appointments found.</div>';
        if (addToRouteBtn) addToRouteBtn.disabled = true;
        return;
    }
    
    let html = '';
    routePlannerState.appointments.forEach((apt, index) => {
        const startTime = new Date(apt.start_time);
        const endTime = new Date(apt.end_time);
        const formattedDate = startTime.toLocaleDateString('en-US', { 
            month: 'short', 
            day: 'numeric',
            year: 'numeric'
        });
        const formattedStartTime = startTime.toLocaleTimeString('en-US', { 
            hour: 'numeric', 
            minute: '2-digit',
            hour12: true 
        });
        const formattedEndTime = endTime.toLocaleTimeString('en-US', { 
            hour: 'numeric', 
            minute: '2-digit',
            hour12: true 
        });
        
        const invitee = apt.invitees && apt.invitees.length > 0 ? apt.invitees[0] : null;
        const inviteeName = invitee ? (invitee.name || invitee.email || 'Unknown') : 'No invitee info';
        
        // Get address from location or invitee questions
        let address = '';
        if (apt.location && apt.location.location) {
            address = apt.location.location;
        } else if (invitee && invitee.questions_and_answers) {
            const addressAnswer = invitee.questions_and_answers.find(q => 
                q.question && (q.question.toLowerCase().includes('address') || q.question.toLowerCase().includes('location'))
            );
            if (addressAnswer) {
                address = addressAnswer.answer;
            }
        }
        
        const isSelected = routePlannerState.selectedAppointments.includes(apt.uri);
        const encodedAddress = encodeURIComponent(address || inviteeName);
        const isCompleted = completedAppointmentsCache.includes(apt.uri);
        
        html += `
            <div class="appointment-route-item ${isSelected ? 'selected' : ''} ${isCompleted ? 'completed' : ''}" data-appointment-uri="${apt.uri}">
                <label class="appointment-checkbox-label">
                    <input type="checkbox" class="appointment-checkbox" value="${apt.uri}" ${isSelected ? 'checked' : ''} onchange="toggleAppointmentSelection('${apt.uri}')">
                    <div class="appointment-route-details">
                        <div class="appointment-route-header">
                            <strong>${inviteeName}</strong>
                            <span class="appointment-route-time">${formattedDate} • ${formattedStartTime} - ${formattedEndTime}</span>
                        </div>
                        ${address ? `<div class="appointment-route-address">📍 ${escapeHtml(address)}</div>` : '<div class="appointment-route-address">📍 No address available</div>'}
                    </div>
                </label>
                <div class="appointment-route-actions">
                    <button class="btn-secondary btn-sm" onclick="openAppointmentDirections('${encodedAddress}')">Directions</button>
                    <button class="btn-secondary btn-sm ${isCompleted ? 'btn-completed' : ''}" onclick="toggleAppointmentCompletion('${apt.uri}')">${isCompleted ? 'Completed' : 'Mark Complete'}</button>
                </div>
            </div>
        `;
    });
    
    appointmentsList.innerHTML = html;
    
    if (addToRouteBtn) {
        addToRouteBtn.disabled = routePlannerState.selectedAppointments.length === 0;
    }
}

// Toggle appointment selection
window.toggleAppointmentSelection = function(appointmentUri) {
    const index = routePlannerState.selectedAppointments.indexOf(appointmentUri);
    if (index > -1) {
        routePlannerState.selectedAppointments.splice(index, 1);
    } else {
        routePlannerState.selectedAppointments.push(appointmentUri);
    }
    
    renderAppointmentsForRoute();
};

// Track last day checked to detect day changes
let lastCheckedDay = new Date().getDate();

// Set up periodic day change check (every hour)
setInterval(checkDayChangeAndRefreshAppointments, 60 * 60 * 1000); // Check every hour

// Also check when page becomes visible (user returns to tab)
document.addEventListener('visibilitychange', function() {
    if (!document.hidden) {
        checkDayChangeAndRefreshAppointments();
    }
});
// Check if day has changed and refresh today's appointments
function checkDayChangeAndRefreshAppointments() {
    const today = new Date();
    const currentDay = today.getDate();
    
    // If day has changed, refresh appointments for today
    if (currentDay !== lastCheckedDay) {
        lastCheckedDay = currentDay;
        
        // Reload appointments to get updated list
        if (typeof loadCalendlyAppointments === 'function') {
            loadCalendlyAppointments();
        }
        
        // Also check local appointments
        loadLocalAppointments();
        
        // Combine and auto-add today's appointments
        setTimeout(() => {
            const combinedAppointments = getCombinedAppointments();
            autoAddTodayAppointmentsToRoute(combinedAppointments);
        }, 1000);
    }
}
// Automatically add today's appointments to route
function autoAddTodayAppointmentsToRoute(appointments) {
    if (!appointments || appointments.length === 0) return;
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Filter appointments for today
    const todayAppointments = appointments.filter(apt => {
        const aptDate = new Date(apt.start_time);
        aptDate.setHours(0, 0, 0, 0);
        return aptDate.getTime() === today.getTime();
    });
    
    if (todayAppointments.length === 0) {
        return; // No appointments today
    }
    
    syncAppointmentsToPlannedEvents(todayAppointments);
    
    // Sort by start time
    todayAppointments.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
    
    let pendingGeocodes = 0;
    let addedCount = 0;
    
    todayAppointments.forEach(apt => {
        // Check if already added to route
        if (routePlannerState.stops.find(s => s.appointmentUri === apt.uri)) {
            return; // Already in route
        }
        
        const invitee = apt.invitees && apt.invitees.length > 0 ? apt.invitees[0] : null;
        const inviteeName = invitee ? (invitee.name || invitee.email || 'Unknown') : 'No invitee info';
        
        // Get address
        let address = '';
        if (apt.location && apt.location.location) {
            address = apt.location.location;
        } else if (invitee && invitee.questions_and_answers) {
            const addressAnswer = invitee.questions_and_answers.find(q => 
                q.question && (q.question.toLowerCase().includes('address') || q.question.toLowerCase().includes('location'))
            );
            if (addressAnswer) {
                address = addressAnswer.answer;
            }
        }
        
        if (!address) {
            console.warn('No address found for appointment:', apt);
            return;
        }
        
        if (!syncQueued) {
            syncQueued = true;
            syncAppointmentsToPlannedEvents(todayAppointments).finally(() => {
                syncQueued = false;
            });
        }
        
        // Geocode address
        if (routePlannerState.isGoogleMapsLoaded && window.google && window.google.maps) {
            pendingGeocodes++;
            const geocoder = new google.maps.Geocoder();
            geocoder.geocode({ address: address }, (results, status) => {
                pendingGeocodes--;
                
                if (status === 'OK' && results[0]) {
                    const location = results[0].geometry.location;
                    const formattedAddress = results[0].formatted_address;
                    
                    const startTime = new Date(apt.start_time);
                    const formattedTime = startTime.toLocaleTimeString('en-US', { 
                        hour: 'numeric', 
                        minute: '2-digit',
                        hour12: true 
                    });
                    
                    const stop = {
                        id: `appt-${apt.uri}`,
                        address: formattedAddress,
                        originalAddress: address,
                        notes: `Appointment: ${inviteeName} at ${formattedTime}`,
                        lat: location.lat(),
                        lng: location.lng(),
                        order: routePlannerState.stops.length,
                        appointmentUri: apt.uri
                    };
                    
                    // Check again if already added (race condition)
                    if (!routePlannerState.stops.find(s => s.appointmentUri === apt.uri)) {
                        routePlannerState.stops.push(stop);
                        addedCount++;
                    }
                }
                
                // After all geocoding is done, update display
                if (pendingGeocodes === 0 && addedCount > 0) {
                    saveStops();
                    renderStopsList();
                    updateMapMarkers();
                    renderAppointmentsCalendar();
                    
                    const optimizeBtn = document.getElementById('optimize-route-btn');
                    if (optimizeBtn) {
                        optimizeBtn.disabled = routePlannerState.stops.length < 2;
                    }
                    
                    if (routePlannerState.stops.length >= 2) {
                        calculateRoute();
                    }
                }
            });
        } else {
            // If Google Maps not loaded yet, try again after a delay
            setTimeout(() => {
                autoAddTodayAppointmentsToRoute([apt]);
            }, 1000);
        }
    });
}
// Add selected appointments to route
function addSelectedAppointmentsToRoute() {
    if (routePlannerState.selectedAppointments.length === 0) {
        alert('Please select at least one appointment');
        return;
    }
    
    const selectedAppts = routePlannerState.appointments.filter(apt => 
        routePlannerState.selectedAppointments.includes(apt.uri)
    );
    
    // Sort by start time
    selectedAppts.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));

    syncAppointmentsToPlannedEvents(selectedAppts);
    
    let addedCount = 0;
    selectedAppts.forEach(apt => {
        const invitee = apt.invitees && apt.invitees.length > 0 ? apt.invitees[0] : null;
        const inviteeName = invitee ? (invitee.name || invitee.email || 'Unknown') : 'No invitee info';
        
        // Get address
        let address = '';
        if (apt.location && apt.location.location) {
            address = apt.location.location;
        } else if (invitee && invitee.questions_and_answers) {
            const addressAnswer = invitee.questions_and_answers.find(q => 
                q.question && (q.question.toLowerCase().includes('address') || q.question.toLowerCase().includes('location'))
            );
            if (addressAnswer) {
                address = addressAnswer.answer;
            }
        }
        
        if (!address) {
            console.warn('No address found for appointment:', apt);
            return;
        }
        
        // Geocode address
        const geocoder = new google.maps.Geocoder();
        geocoder.geocode({ address: address }, (results, status) => {
            if (status === 'OK' && results[0]) {
                const location = results[0].geometry.location;
                const formattedAddress = results[0].formatted_address;
                
                const startTime = new Date(apt.start_time);
                const formattedTime = startTime.toLocaleTimeString('en-US', { 
                    hour: 'numeric', 
                    minute: '2-digit',
                    hour12: true 
                });
                
                const stop = {
                    id: `appt-${apt.uri}`,
                    address: formattedAddress,
                    originalAddress: address,
                    notes: `Appointment: ${inviteeName} at ${formattedTime}`,
                    lat: location.lat(),
                    lng: location.lng(),
                    order: routePlannerState.stops.length,
                    appointmentUri: apt.uri
                };
                
                // Check if already added
                if (!routePlannerState.stops.find(s => s.appointmentUri === apt.uri)) {
                    routePlannerState.stops.push(stop);
                    addedCount++;
                }
            }
            
            // After all geocoding, update display
            if (addedCount > 0) {
                saveStops();
                renderStopsList();
                updateMapMarkers();
                renderAppointmentsCalendar();
                
                const optimizeBtn = document.getElementById('optimize-route-btn');
                if (optimizeBtn) {
                    optimizeBtn.disabled = routePlannerState.stops.length < 2;
                }
                
                if (routePlannerState.stops.length >= 2) {
                    calculateRoute();
                }
                
                // Clear selections
                routePlannerState.selectedAppointments = [];
                renderAppointmentsForRoute();
            }
        });
    });
}
// Open create appointment modal
function openCreateAppointmentModal() {
    const modal = document.getElementById('create-appointment-modal');
    if (modal) {
        modal.style.display = 'block';
        
        // Set default date to today
        const dateInput = document.getElementById('appointment-date');
        if (dateInput) {
            const today = new Date();
            dateInput.value = today.toISOString().split('T')[0];
        }
        
        // Clear form
        document.getElementById('create-appointment-form').reset();
        document.getElementById('appointment-conflict-warning').style.display = 'none';
    }
}

// Setup customer autocomplete for appointment form
function setupAppointmentCustomerAutocomplete() {
    const customerInput = document.getElementById('appointment-customer');
    const autocompleteDiv = document.getElementById('appointment-customer-autocomplete');
    
    if (!customerInput || !autocompleteDiv) return;
    
    let autocompleteTimeout;
    
    customerInput.addEventListener('input', (e) => {
        const query = e.target.value.trim();
        
        clearTimeout(autocompleteTimeout);
        
        if (query.length < 2) {
            autocompleteDiv.innerHTML = '';
            autocompleteDiv.style.display = 'none';
            return;
        }
        
        autocompleteTimeout = setTimeout(() => {
            const customers = getCustomersData();
            const matches = Object.values(customers).filter(customer => {
                const name = (customer.name || '').toLowerCase();
                const phone = (customer.phone || '').replace(/\D/g, '');
                const queryLower = query.toLowerCase();
                const queryDigits = query.replace(/\D/g, '');
                
                return name.includes(queryLower) || phone.includes(queryDigits);
            }).slice(0, 5);
            
            if (matches.length > 0) {
                let html = '';
                matches.forEach(customer => {
                    html += `
                        <div class="autocomplete-item" onclick="selectCustomerForAppointment('${customer.name.replace(/'/g, "\\'")}', '${(customer.address || '').replace(/'/g, "\\'")}', '${(customer.phone || '').replace(/'/g, "\\'")}')">
                            <div class="autocomplete-item-name">${escapeHtml(customer.name)}</div>
                            ${customer.address ? `<div class="autocomplete-item-detail">${escapeHtml(customer.address)}</div>` : ''}
                        </div>
                    `;
                });
                autocompleteDiv.innerHTML = html;
                autocompleteDiv.style.display = 'block';
            } else {
                autocompleteDiv.innerHTML = '';
                autocompleteDiv.style.display = 'none';
            }
        }, 300);
    });
    
    document.addEventListener('click', (e) => {
        if (!customerInput.contains(e.target) && !autocompleteDiv.contains(e.target)) {
            autocompleteDiv.style.display = 'none';
        }
    });
}

// Select customer for appointment
window.selectCustomerForAppointment = function(name, address, phone) {
    const customerInput = document.getElementById('appointment-customer');
    const addressInput = document.getElementById('appointment-address');
    const autocompleteDiv = document.getElementById('appointment-customer-autocomplete');
    
    if (customerInput) customerInput.value = name;
    if (addressInput && address) addressInput.value = address;
    if (autocompleteDiv) autocompleteDiv.style.display = 'none';
    
    // Check for conflicts
    checkAppointmentConflicts();
};

// Check for appointment conflicts
function checkAppointmentConflicts() {
    const dateInput = document.getElementById('appointment-date');
    const timeInput = document.getElementById('appointment-start-time');
    const durationInput = document.getElementById('appointment-duration');
    const conflictWarning = document.getElementById('appointment-conflict-warning');
    const conflictDetails = document.getElementById('conflict-details');
    const saveBtn = document.getElementById('save-appointment-btn');
    
    if (!dateInput || !timeInput || !durationInput || !conflictWarning) return;
    
    const date = dateInput.value;
    const time = timeInput.value;
    const duration = parseInt(durationInput.value);
    
    if (!date || !time) {
        conflictWarning.style.display = 'none';
        if (saveBtn) saveBtn.disabled = false;
        return;
    }
    
    // Calculate appointment times
    const appointmentStart = new Date(`${date}T${time}`);
    const appointmentEnd = new Date(appointmentStart.getTime() + duration * 60000);
    
    // Check against existing appointments (both Calendly and local)
    const allExistingAppointments = getCombinedAppointments();
    const conflicts = allExistingAppointments.filter(apt => {
        const aptStart = new Date(apt.start_time);
        const aptEnd = new Date(apt.end_time);
        
        // Check if times overlap
        return (appointmentStart < aptEnd && appointmentEnd > aptStart);
    });
    
    if (conflicts.length > 0) {
        conflictWarning.style.display = 'block';
        let html = '<ul style="margin: 0.5rem 0 0 1.5rem; padding: 0;">';
        conflicts.forEach(conflict => {
            const startTime = new Date(conflict.start_time);
            const endTime = new Date(conflict.end_time);
            const invitee = conflict.invitees && conflict.invitees.length > 0 ? conflict.invitees[0] : null;
            const inviteeName = invitee ? (invitee.name || invitee.email || 'Unknown') : 'Unknown';
            
            html += `<li>${inviteeName}: ${startTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })} - ${endTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}</li>`;
        });
        html += '</ul>';
        conflictDetails.innerHTML = html;
        if (saveBtn) saveBtn.disabled = true;
    } else {
        conflictWarning.style.display = 'none';
        if (saveBtn) saveBtn.disabled = false;
    }
}

// Handle create appointment
async function handleCreateAppointment(e) {
    e.preventDefault();
    
    const customer = document.getElementById('appointment-customer').value.trim();
    const address = document.getElementById('appointment-address').value.trim();
    const date = document.getElementById('appointment-date').value;
    const startTime = document.getElementById('appointment-start-time').value;
    const duration = parseInt(document.getElementById('appointment-duration').value);
    const notes = document.getElementById('appointment-notes').value.trim();
    
    if (!address || !date || !startTime) {
        alert('Please fill in all required fields');
        return;
    }
    
    // Check conflicts one more time (check against both Calendly and local appointments)
    const appointmentStart = new Date(`${date}T${startTime}`);
    const appointmentEnd = new Date(appointmentStart.getTime() + duration * 60000);
    
    const allExistingAppointments = getCombinedAppointments();
    const conflicts = allExistingAppointments.filter(apt => {
        const aptStart = new Date(apt.start_time);
        const aptEnd = new Date(apt.end_time);
        return (appointmentStart < aptEnd && appointmentEnd > aptStart);
    });
    
    if (conflicts.length > 0) {
        alert('This appointment conflicts with an existing appointment. Please choose a different time.');
        return;
    }
    
    // Create appointment object (stored locally since we can't create via Calendly API without webhook)
    const appointment = {
        id: Date.now().toString(),
        customer: customer,
        address: address,
        date: date,
        startTime: startTime,
        duration: duration,
        notes: notes,
        startDateTime: appointmentStart.toISOString(),
        endDateTime: appointmentEnd.toISOString(),
        created: Date.now()
    };
    
    // Save to localStorage
    const savedAppointments = JSON.parse(localStorage.getItem('localAppointments') || '[]');
    savedAppointments.push(appointment);
    localStorage.setItem('localAppointments', JSON.stringify(savedAppointments));
    
    // Add to route planner state
    const localAppt = {
        uri: `local-${appointment.id}`,
        name: `House Call - ${customer || 'Customer'}`,
        start_time: appointmentStart.toISOString(),
        end_time: appointmentEnd.toISOString(),
        location: { location: address },
        invitees: [{
            name: customer || 'Customer',
            email: '',
            questions_and_answers: []
        }]
    };
    
    routePlannerState.appointments.push(localAppt);
    routePlannerState.appointments.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
    
    // Close modal
    const modal = document.getElementById('create-appointment-modal');
    if (modal) {
        modal.style.display = 'none';
    }
    
    // Refresh appointments list
    renderAppointmentsForRoute();
    
    // Update calendar to show the new appointment (combine with Calendly appointments, deduplicated)
    renderAppointmentsCalendar();
    
    alert('Appointment created successfully! You can now add it to your route.');
}
// Load local appointments on init
function loadLocalAppointments() {
    const saved = localStorage.getItem('localAppointments');
    if (saved) {
        try {
            const localAppointments = JSON.parse(saved);
            localAppointments.forEach(appt => {
                const localAppt = {
                    uri: `local-${appt.id}`,
                    name: `House Call - ${appt.customer || 'Customer'}`,
                    start_time: appt.startDateTime,
                    end_time: appt.endDateTime,
                    location: { location: appt.address },
                    invitees: [{
                        name: appt.customer || 'Customer',
                        email: '',
                        questions_and_answers: []
                    }]
                };
                
                // Check if already exists
                if (!routePlannerState.appointments.find(a => a.uri === localAppt.uri)) {
                    routePlannerState.appointments.push(localAppt);
                }
            });
            
            routePlannerState.appointments.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
            renderAppointmentsCalendar();
        } catch (e) {
            console.error('Error loading local appointments:', e);
        }
    }
}
function renderTodayAppointments(appointments) {
    const listEl = document.getElementById('today-appointments-list');
    const titleEl = document.querySelector('.today-appointments-section .section-header h3');
    if (!listEl) return;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const todaysAppointments = (appointments ?? getCombinedAppointments()).filter(apt => {
        if (!apt?.start_time) return false;
        const start = new Date(apt.start_time);
        start.setHours(0, 0, 0, 0);
        return start.getTime() === today.getTime();
    }).sort((a, b) => new Date(a.start_time) - new Date(b.start_time));

    if (titleEl) {
        titleEl.textContent = `Today's Appointments (${todaysAppointments.length})`;
    }

    if (todaysAppointments.length === 0) {
        listEl.innerHTML = '<div class="empty-message">No appointments scheduled for today.</div>';
        return;
    }

    const html = todaysAppointments.map(apt => {
            const startTime = new Date(apt.start_time);
        const endTime = new Date(apt.end_time ?? apt.start_time);
        const formattedStart = startTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
        const formattedEnd = endTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
        const invitee = apt.invitees && apt.invitees.length ? apt.invitees[0] : null;
        const inviteeName = invitee ? (invitee.name || invitee.email || 'Unknown') : (apt.customer || apt.name || 'Unknown');
        let address = '';
        if (apt.location?.location) {
            address = apt.location.location;
        } else if (invitee?.questions_and_answers) {
            const answer = invitee.questions_and_answers.find(q => q.question && (q.question.toLowerCase().includes('address') || q.question.toLowerCase().includes('location')));
            if (answer) address = answer.answer;
        }
        const encodedAddress = encodeURIComponent(address || inviteeName);
        const isCompleted = completedAppointmentsCache.includes(apt.uri);

        return `
            <div class="today-appointment-card ${isCompleted ? 'completed' : ''}">
                <div class="today-appointment-header">
                    <div class="today-appointment-time">${formattedStart} - ${formattedEnd}</div>
                    <div class="today-appointment-title">${escapeHtml(inviteeName)}</div>
                </div>
                <div class="today-appointment-body">
                    ${address ? `<div class="today-appointment-address">📍 ${escapeHtml(address)}</div>` : '<div class="today-appointment-address">📍 No address available</div>'}
                </div>
                <div class="today-appointment-actions">
                    <button class="btn-secondary btn-sm" onclick="openAppointmentDirections('${encodedAddress}')">Directions</button>
                    <button class="btn-secondary btn-sm ${isCompleted ? 'btn-completed' : ''}" onclick="toggleAppointmentCompletion('${apt.uri}')">${isCompleted ? 'Completed' : 'Mark Complete'}</button>
                </div>
            </div>
        `;
    }).join('');
    
    listEl.innerHTML = html;
}
// Show day details
window.showDayDetails = function(dateKey, day) {
    const modal = document.getElementById('day-details-modal');
    const titleEl = document.getElementById('day-details-title');
    const contentEl = document.getElementById('day-details-content');
    
    if (!modal || !titleEl || !contentEl) return;
    
    // Get all appointments (from both Calendly and local)
    const combinedAppointments = getCombinedAppointments();
    
    // Filter appointments for this date
    const dayAppointments = combinedAppointments.filter(apt => {
        const aptDate = new Date(apt.start_time);
        const aptDateKey = `${aptDate.getFullYear()}-${String(aptDate.getMonth() + 1).padStart(2, '0')}-${String(aptDate.getDate()).padStart(2, '0')}`;
        return aptDateKey === dateKey;
    });
    
    if (dayAppointments.length === 0) {
        contentEl.innerHTML = '<div class="empty-message">No appointments scheduled for this day.</div>';
    } else {
        // Sort by time
        dayAppointments.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
        
        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 
                           'July', 'August', 'September', 'October', 'November', 'December'];
        const [year, month, date] = dateKey.split('-');
        titleEl.textContent = `${monthNames[parseInt(month) - 1]} ${parseInt(date)}, ${year}`;
        
        let html = '';
        dayAppointments.forEach(apt => {
            const startTime = new Date(apt.start_time);
            const endTime = new Date(apt.end_time);
            const formattedStartTime = startTime.toLocaleTimeString('en-US', { 
                hour: 'numeric', 
                minute: '2-digit',
                hour12: true 
            });
            const formattedEndTime = endTime.toLocaleTimeString('en-US', { 
                hour: 'numeric', 
                minute: '2-digit',
                hour12: true 
            });
            
            const invitee = apt.invitees && apt.invitees.length > 0 ? apt.invitees[0] : null;
            const inviteeName = invitee ? (invitee.name || invitee.email || 'Unknown') : 'No invitee info';
            const inviteeEmail = invitee ? (invitee.email || '') : '';
            const inviteePhone = invitee && invitee.questions_and_answers ? 
                invitee.questions_and_answers.find(q => q.question && q.question.toLowerCase().includes('phone'))?.answer || '' : '';
            
            // Get address
            let address = '';
            if (apt.location && apt.location.location) {
                address = apt.location.location;
            } else if (invitee && invitee.questions_and_answers) {
                const addressAnswer = invitee.questions_and_answers.find(q => 
                    q.question && (q.question.toLowerCase().includes('address') || q.question.toLowerCase().includes('location'))
                );
                if (addressAnswer) {
                    address = addressAnswer.answer;
                }
            }
            
            html += `
                <div class="day-appointment-card">
                    <div class="day-appointment-header">
                        <div class="day-appointment-time">
                            <strong>${formattedStartTime} - ${formattedEndTime}</strong>
                        </div>
                        <div class="day-appointment-title">
                            ${apt.name || 'House Call'}
                        </div>
                    </div>
                    <div class="day-appointment-body">
                        <div class="day-appointment-customer">
                            <strong>👤 Customer:</strong> ${inviteeName}
                        </div>
                        ${inviteeEmail ? `<div class="day-appointment-email"><strong>✉️ Email:</strong> ${inviteeEmail}</div>` : ''}
                        ${inviteePhone ? `<div class="day-appointment-phone"><strong>📞 Phone:</strong> ${inviteePhone}</div>` : ''}
                        ${address ? `<div class="day-appointment-address"><strong>📍 Address:</strong> ${address}</div>` : '<div class="day-appointment-address"><strong>📍 Address:</strong> No address available</div>'}
                        ${apt.description ? `<div class="day-appointment-notes"><strong>📝 Notes:</strong> ${apt.description}</div>` : ''}
                    </div>
                </div>
            `;
        });
        
        contentEl.innerHTML = html;
    }
    
    modal.style.display = 'block';
};

// Close day details modal
window.closeDayDetailsModal = function() {
    const modal = document.getElementById('day-details-modal');
    if (modal) {
        modal.style.display = 'none';
    }
};

// Render appointments list (kept for backward compatibility, but now uses calendar)
function renderAppointments(appointments) {
    // Use calendar view instead
    renderAppointmentsCalendar(appointments);
}
// Filter appointments
function filterAppointments(filter) {
    currentAppointmentFilter = filter;
    const now = new Date();
    
    // Combine all appointments (Calendly + local)
    const combinedAppointments = getCombinedAppointments();
    let filtered = [...combinedAppointments];
    
    if (filter === 'today') {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        filtered = combinedAppointments.filter(apt => {
            const aptDate = new Date(apt.start_time);
            return aptDate >= today && aptDate < tomorrow;
        });
        // Set calendar to current month
        calendarState.currentMonth = now.getMonth();
        calendarState.currentYear = now.getFullYear();
    } else if (filter === 'week') {
        const weekEnd = new Date(now);
        weekEnd.setDate(weekEnd.getDate() + 7);
        filtered = combinedAppointments.filter(apt => {
            const aptDate = new Date(apt.start_time);
            return aptDate >= now && aptDate <= weekEnd;
        });
        // Set calendar to current month
        calendarState.currentMonth = now.getMonth();
        calendarState.currentYear = now.getFullYear();
    } else if (filter === 'month') {
        const monthEnd = new Date(now);
        monthEnd.setMonth(monthEnd.getMonth() + 1);
        filtered = combinedAppointments.filter(apt => {
            const aptDate = new Date(apt.start_time);
            return aptDate >= now && aptDate <= monthEnd;
        });
        // Set calendar to current month
        calendarState.currentMonth = now.getMonth();
        calendarState.currentYear = now.getFullYear();
    }
    
    renderAppointmentsCalendar(filtered);
}

// ============================================
// SETTINGS MANAGEMENT
// ============================================

// Ensure employee profile exists for a user (creates if missing)
async function ensureEmployeeProfile(user) {
    if (!USE_SUPABASE || !supabase) return;
    if (!user || !user.id) return;
    
    try {
        // Check if profile already exists
        const { data: existingProfile, error: checkError } = await supabase
            .from('user_profiles')
            .select('user_id')
            .eq('user_id', user.id)
            .maybeSingle();
        
        // If profile doesn't exist, create it
        if (!existingProfile) {
            const { error: insertError } = await supabase
                .from('user_profiles')
                .insert({
                    user_id: user.id,
                    email: user.email || '',
                    full_name: user.user_metadata?.full_name || user.email?.split('@')[0] || 'User',
                    role: 'user', // Default role for new employees
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                });
            
            if (insertError) {
                // If table doesn't exist, just log a warning
                if (!insertError.message.includes('relation "user_profiles" does not exist')) {
                    console.warn('Could not create employee profile:', insertError);
                }
            } else {
                console.log('Employee profile created automatically for:', user.email);
            }
        }
    } catch (error) {
        // Silently fail if table doesn't exist - settings migration might not be run yet
        if (!error.message?.includes('relation "user_profiles" does not exist')) {
            console.warn('Error ensuring employee profile:', error);
        }
    }
}

// Load settings page
async function loadSettings() {
    await loadProfile();
    const adminStatus = await isAdmin();
    await checkAdminAccess();
    if (adminStatus) {
        await loadAdmins();
        await loadRoles();
        await loadEmployees();
        
        // Re-initialize employee form listeners (only once per Settings tab load)
        initEmployeeFormListeners();
    }
    
    // Re-initialize profile picture upload listeners when Settings tab is opened
    initProfilePictureUpload();
}
// Initialize employee form listeners (called only from loadSettings to prevent duplicates)
let employeeFormSubmitHandler = null; // Store handler reference

function initEmployeeFormListeners() {
    const editEmployeeForm = document.getElementById('edit-employee-form');
    if (!editEmployeeForm) return;
    
    // Remove old handler if it exists
    if (employeeFormSubmitHandler) {
        editEmployeeForm.removeEventListener('submit', employeeFormSubmitHandler);
    }
    
    // Create new handler
    employeeFormSubmitHandler = async function(e) {
        e.preventDefault();
        e.stopPropagation();
        
        // Check if already updating
        if (isUpdatingEmployee) {
            console.log('Employee update already in progress, ignoring duplicate submit');
            return;
        }
        
        try {
            const userId = document.getElementById('edit-employee-user-id').value;
            const name = document.getElementById('edit-employee-name').value;
            const role = document.getElementById('edit-employee-role-select').value;
            
            // Disable submit button
            const submitBtn = editEmployeeForm.querySelector('button[type="submit"]');
            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.textContent = 'Saving...';
            }
            
            const success = await updateEmployee(userId, name, role, true);
            
            if (success) {
                // Show success message only once, after update completes
                alert('Employee updated successfully!');
                
                // Reset form after successful update
                if (editEmployeeForm) {
                    editEmployeeForm.reset();
                }
            }
        } catch (error) {
            console.error('Error in form submission:', error);
        } finally {
            // Always re-enable submit button
            const submitBtn = editEmployeeForm.querySelector('button[type="submit"]');
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Save Changes';
            }
        }
    };
    
    // Add the handler
    editEmployeeForm.addEventListener('submit', employeeFormSubmitHandler);
    console.log('Employee form listeners initialized');
}
// Initialize profile picture upload functionality
function initProfilePictureUpload() {
    console.log('🔧 Initializing profile picture upload...');
    
    const changePictureBtn = document.getElementById('change-picture-btn');
    const profilePictureInput = document.getElementById('profile-picture-input');
    const profilePicturePreview = document.getElementById('profile-picture-preview');
    const profilePicturePlaceholder = document.getElementById('profile-picture-placeholder');
    
    console.log('📋 Profile picture elements found:', {
        changeBtn: !!changePictureBtn,
        input: !!profilePictureInput,
        preview: !!profilePicturePreview,
        placeholder: !!profilePicturePlaceholder
    });
    
    if (!changePictureBtn || !profilePictureInput) {
        console.error('❌ Profile picture elements not found! Make sure you are on the Settings tab.');
        return;
    }
    
    // Remove existing listeners to avoid duplicates by cloning nodes
    try {
        const newChangeBtn = changePictureBtn.cloneNode(true);
        changePictureBtn.parentNode.replaceChild(newChangeBtn, changePictureBtn);
        
        const newInput = profilePictureInput.cloneNode(true);
        profilePictureInput.parentNode.replaceChild(newInput, profilePictureInput);
    } catch (e) {
        console.warn('Could not clone nodes (may already be initialized):', e);
    }
    
    // Re-get references after cloning
    const btn = document.getElementById('change-picture-btn');
    const input = document.getElementById('profile-picture-input');
    
    if (!btn || !input) {
        console.error('❌ Could not re-find elements after cloning');
        return;
    }
    
    // Set up click handler
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        console.log('🖱️ Change picture button clicked');
        input.click();
    });
    // Set up file change handler
    input.addEventListener('change', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const file = e.target.files[0];
        console.log('📁 File selected:', file ? { name: file.name, size: file.size, type: file.type } : 'none');
        
        if (!file) {
            console.warn('⚠️ No file selected');
            return;
        }
        
        // Validate file type
        if (!file.type.startsWith('image/')) {
            alert('Please select an image file (JPEG, PNG, etc.)');
            input.value = ''; // Clear the input
            return;
        }
        
        // Show immediate preview using FileReader
        console.log('📖 Reading file with FileReader...');
        const reader = new FileReader();
        
        reader.onload = function(event) {
            console.log('✅ FileReader loaded successfully');
            const preview = document.getElementById('profile-picture-preview');
            const placeholder = document.getElementById('profile-picture-placeholder');
            
            if (preview) {
                // Store FileReader result as fallback
                preview.dataset.fallback = event.target.result;
                preview.src = event.target.result;
                preview.style.display = 'block';
                preview.style.visibility = 'visible';
                preview.style.opacity = '1';
                preview.style.width = '150px';
                preview.style.height = '150px';
                
                console.log('✅ Preview updated with FileReader - image src set:', preview.src.substring(0, 50) + '...');
                console.log('✅ Preview display:', {
                    display: preview.style.display,
                    visibility: preview.style.visibility,
                    opacity: preview.style.opacity,
                    srcLength: preview.src.length
                });
                
                if (placeholder) {
                    placeholder.style.display = 'none';
                }
                
                // Force a reflow to ensure the image renders
                preview.offsetHeight;
            } else {
                console.error('❌ profile-picture-preview element not found in FileReader handler');
            }
        };
        
        reader.onerror = function(error) {
            console.error('❌ FileReader error:', error);
            alert('Error reading image file. Please try again.');
        };
        
        reader.onprogress = function(e) {
            if (e.lengthComputable) {
                const percentLoaded = Math.round((e.loaded / e.total) * 100);
                console.log(`📊 FileReader progress: ${percentLoaded}%`);
            }
        };
        
        reader.readAsDataURL(file);
        
        // Then upload to server
        console.log('☁️ Starting upload to server...');
        uploadProfilePicture(file);
    });
    
    console.log('✅ Profile picture upload initialized successfully');
}

// ============================================
// PROFILE MANAGEMENT
// ============================================

// Load user profile
async function loadProfile() {
    if (!currentUser) return;
    
    const profileNameInput = document.getElementById('profile-name');
    const profileEmailInput = document.getElementById('profile-email');
    const profilePicturePreview = document.getElementById('profile-picture-preview');
    const profilePicturePlaceholder = document.getElementById('profile-picture-placeholder');
    
    if (!profileNameInput || !profileEmailInput) return;
    
    // Set email (read-only)
    profileEmailInput.value = currentUser.email || '';
    
    // Load profile data
    try {
        const profile = await getUserProfile();
        if (profile) {
            profileNameInput.value = profile.full_name || '';
            
            // Load profile picture
            if (profile.profile_picture_url) {
                if (profilePicturePreview) {
                    // Add cache busting to ensure fresh image
                    const imageUrl = profile.profile_picture_url + (profile.profile_picture_url.includes('?') ? '&' : '?') + 't=' + Date.now();
                    profilePicturePreview.src = imageUrl;
                    profilePicturePreview.onload = function() {
                        profilePicturePreview.style.display = 'block';
                        if (profilePicturePlaceholder) {
                            profilePicturePlaceholder.style.display = 'none';
                        }
                    };
                    profilePicturePreview.onerror = function() {
                        console.error('Error loading profile picture');
                        // Fall back to placeholder if image fails to load
                        profilePicturePreview.style.display = 'none';
                        if (profilePicturePlaceholder) {
                            profilePicturePlaceholder.style.display = 'flex';
                        }
                    };
                }
            } else {
                // Show initials
                const fullName = profile.full_name || currentUser.user_metadata?.full_name || '';
                if (fullName && profilePicturePlaceholder) {
                    const initials = fullName.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
                    profilePicturePlaceholder.textContent = initials;
                    profilePicturePlaceholder.style.display = 'flex';
                    if (profilePicturePreview) {
                        profilePicturePreview.style.display = 'none';
                    }
                }
            }
        } else {
            // Use metadata if no profile
            const fullName = currentUser.user_metadata?.full_name || '';
            profileNameInput.value = fullName;
            
            // Show initials
            if (fullName && profilePicturePlaceholder) {
                const initials = fullName.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
                profilePicturePlaceholder.textContent = initials;
                profilePicturePlaceholder.style.display = 'flex';
            }
        }
    } catch (error) {
        console.error('Error loading profile:', error);
    }
}

// Save user profile
async function saveProfile() {
    if (!currentUser) return;
    
    const profileNameInput = document.getElementById('profile-name');
    if (!profileNameInput) return;
    
    const fullName = profileNameInput.value.trim();
    if (!fullName) {
        alert('Please enter your full name');
        return;
    }
    if (!USE_SUPABASE || !supabase) {
        alert('Profile saving is disabled while running in local-only mode.');
        return;
    }
    
    try {
        const userId = getUserId();
        const saveBtn = document.getElementById('save-profile-btn');
        
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.textContent = 'Saving...';
        }
        
        // Upsert profile (create if doesn't exist)
        const { data, error } = await supabase
            .from('user_profiles')
            .upsert({
                user_id: userId,
                email: currentUser.email,
                full_name: fullName,
                updated_at: new Date().toISOString()
            }, {
                onConflict: 'user_id'
            })
            .select()
            .single();
        
        if (error) {
            // If table doesn't exist, show helpful message
            if (error.message.includes('relation "user_profiles" does not exist')) {
                alert('Settings tables not set up yet. Please run the SQL migration from settings_schema.sql in your Supabase SQL Editor.');
                if (saveBtn) {
                    saveBtn.disabled = false;
                    saveBtn.textContent = 'Save Profile';
                }
                return;
            }
            throw error;
        }
        
        // Update user metadata
        try {
            await supabase.auth.updateUser({
                data: {
                    full_name: fullName
                }
            });
        } catch (metaError) {
            console.warn('Could not update user metadata:', metaError);
            // Continue anyway
        }
        
        // Reload current user session
        const { data: { session } } = await supabase.auth.getSession();
        if (session) {
            currentUser = session.user;
        }
        
        // Update welcome message
        updateWelcomeMessage();
        
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save Profile';
        }
        
        alert('Profile saved successfully!');
    } catch (error) {
        console.error('Error saving profile:', error);
        const saveBtn = document.getElementById('save-profile-btn');
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save Profile';
        }
        alert('Error saving profile: ' + (error.message || 'Unknown error'));
    }
}
// Upload profile picture
async function uploadProfilePicture(file) {
    if (!currentUser || !file) {
        console.error('No user or file provided');
        return;
    }
    if (!USE_SUPABASE || !supabase) {
        alert('Profile pictures are disabled while running in local-only mode.');
        return;
    }
    
    // Validate file type
    if (!file.type.startsWith('image/')) {
        alert('Please select an image file');
        return;
    }
    
    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
        alert('Image size must be less than 5MB');
        return;
    }
    const changeBtn = document.getElementById('change-picture-btn');
    const profilePictureInput = document.getElementById('profile-picture-input');
    
    try {
        const userId = getUserId();
        if (!userId) {
            throw new Error('User ID not found');
        }
        
        const fileExt = file.name.split('.').pop();
        const fileName = `${userId}-${Date.now()}.${fileExt}`;
        const filePath = `profiles/${fileName}`;
        
        console.log('Uploading profile picture:', { fileName, filePath, fileSize: file.size });
        
        // Show loading state
        if (changeBtn) {
            changeBtn.disabled = true;
            changeBtn.textContent = 'Uploading...';
        }
        
        // Upload to Supabase Storage
        const { data: uploadData, error: uploadError } = await supabase.storage
            .from('avatars')
            .upload(filePath, file, {
                cacheControl: '3600',
                upsert: true // Allow overwriting existing files
            });
        
        if (uploadError) {
            console.error('Upload error:', uploadError);
            if (uploadError.message.includes('Bucket not found') || uploadError.message.includes('The resource was not found')) {
                const errorMsg = `Avatar storage bucket not found!\n\n` +
                    `To fix this:\n` +
                    `1. Go to Supabase Dashboard → Storage\n` +
                    `2. Click "New Bucket"\n` +
                    `3. Name: "avatars" (exactly)\n` +
                    `4. ✅ Check "Public bucket"\n` +
                    `5. Click "Create bucket"\n` +
                    `6. Run the SQL from "storage_policies.sql" in SQL Editor\n\n` +
                    `See STORAGE_SETUP.md for detailed instructions.`;
                alert(errorMsg);
                if (changeBtn) {
                    changeBtn.disabled = false;
                    changeBtn.textContent = 'Change Picture';
                }
                return;
            }
            if (uploadError.message.includes('new row violates row-level security') || uploadError.message.includes('permission denied')) {
                const errorMsg = `Permission denied!\n\n` +
                    `The "avatars" bucket exists but RLS policies are missing.\n\n` +
                    `To fix:\n` +
                    `1. Open "storage_policies.sql" in this project\n` +
                    `2. Copy the SQL\n` +
                    `3. Go to Supabase Dashboard → SQL Editor\n` +
                    `4. Paste and run the SQL\n\n` +
                    `See STORAGE_SETUP.md for details.`;
                alert(errorMsg);
                if (changeBtn) {
                    changeBtn.disabled = false;
                    changeBtn.textContent = 'Change Picture';
                }
                return;
            }
            throw uploadError;
        }
        
        console.log('Upload successful:', uploadData);
        
        // Get public URL with cache busting
        const { data: urlData } = supabase.storage
            .from('avatars')
            .getPublicUrl(filePath);
        const publicUrl = urlData.publicUrl + '?t=' + Date.now(); // Add timestamp to force refresh
        
        console.log('Public URL:', publicUrl);
        
        // Update profile with picture URL
        const { data: profileData, error: updateError } = await supabase
            .from('user_profiles')
            .upsert({
                user_id: userId,
                profile_picture_url: publicUrl.split('?')[0], // Store URL without timestamp
                updated_at: new Date().toISOString()
            }, {
                onConflict: 'user_id'
            })
            .select();
        
        if (updateError) {
            console.error('Profile update error:', updateError);
            throw updateError;
        }
        console.log('Profile updated:', profileData);
        
        // Clear file input
        if (profilePictureInput) {
            profilePictureInput.value = '';
        }
        
        // Update preview immediately with cache-busted URL
        const profilePicturePreview = document.getElementById('profile-picture-preview');
        const profilePicturePlaceholder = document.getElementById('profile-picture-placeholder');
        
        console.log('Updating profile picture preview elements:', {
            preview: !!profilePicturePreview,
            placeholder: !!profilePicturePlaceholder,
            url: publicUrl
        });
        
        if (profilePicturePreview) {
            // Remove old event listeners to avoid duplicates
            profilePicturePreview.onload = null;
            profilePicturePreview.onerror = null;
            
            // Set onload handler to show image when loaded
            profilePicturePreview.onload = function() {
                console.log('Profile picture loaded successfully from server');
                profilePicturePreview.style.display = 'block';
                profilePicturePreview.style.opacity = '1';
                if (profilePicturePlaceholder) {
                    profilePicturePlaceholder.style.display = 'none';
                }
            };
            
            // Set onerror handler for debugging
            profilePicturePreview.onerror = function() {
                console.error('Error loading profile picture image from server URL:', publicUrl);
                // Fallback to FileReader preview if server image fails to load
                if (profilePicturePreview.dataset.fallback) {
                    console.log('Falling back to FileReader preview');
                    profilePicturePreview.src = profilePicturePreview.dataset.fallback;
                }
            };
            
            // Only update if the URL is different from current src
            // This preserves the FileReader preview until server image loads
            if (profilePicturePreview.src !== publicUrl && !profilePicturePreview.src.includes('data:')) {
                profilePicturePreview.src = publicUrl;
                console.log('Set new profile picture src from server:', publicUrl);
            } else if (profilePicturePreview.src.includes('data:')) {
                // If currently showing FileReader preview, update to server URL
                // But don't clear it - let the onload handler update display
                const currentSrc = profilePicturePreview.src;
                profilePicturePreview.src = publicUrl;
                console.log('Updating from FileReader preview to server URL:', publicUrl);
            }
        } else {
            console.error('profile-picture-preview element not found!');
        }
        
        // Reload profile to ensure everything is in sync (with a slight delay to allow image to process)
        setTimeout(async () => {
            await loadProfile();
            await updateWelcomeMessage();
        }, 500);
        
        if (changeBtn) {
            changeBtn.disabled = false;
            changeBtn.textContent = 'Change Picture';
        }
        
        console.log('Profile picture upload completed successfully');
        
        // Verify the image is visible
        setTimeout(() => {
            const preview = document.getElementById('profile-picture-preview');
            if (preview && preview.style.display === 'none') {
                console.warn('Preview image is still hidden, forcing display');
                preview.style.display = 'block';
                preview.style.visibility = 'visible';
                preview.style.opacity = '1';
            }
        }, 1000);
        
        alert('Profile picture uploaded successfully!');
    } catch (error) {
        console.error('Error uploading profile picture:', error);
        if (changeBtn) {
            changeBtn.disabled = false;
            changeBtn.textContent = 'Change Picture';
        }
        
        let errorMessage = 'Error uploading profile picture: ';
        if (error.message) {
            errorMessage += error.message;
        } else if (error.error_description) {
            errorMessage += error.error_description;
        } else {
            errorMessage += 'Unknown error. Please check the console for details.';
        }
        
        alert(errorMessage);
    }
}
// ============================================
// ADMIN MANAGEMENT
// ============================================
// Check if user is admin
async function isAdmin() {
    if (!currentUser) return false;
    
    try {
        const userId = getUserId();
        const { data, error } = await supabase
            .from('user_profiles')
            .select('role')
            .eq('user_id', userId)
            .single();
        
        if (error && error.code !== 'PGRST116') {
            console.error('Error checking admin status:', error);
            return false;
        }
        
        return data && (data.role === 'admin' || data.role === 'super_admin');
    } catch (error) {
        console.error('Error checking admin:', error);
        return false;
    }
}

// Check admin access and show/hide admin sections
async function checkAdminAccess() {
    const adminSection = document.getElementById('admin-section');
    const rolesSection = document.getElementById('roles-section');
    const employeesSection = document.getElementById('employees-section');
    
    if (await isAdmin()) {
        if (adminSection) adminSection.style.display = 'block';
        if (rolesSection) rolesSection.style.display = 'block';
        if (employeesSection) employeesSection.style.display = 'block';
    } else {
        if (adminSection) adminSection.style.display = 'none';
        if (rolesSection) rolesSection.style.display = 'none';
        if (employeesSection) employeesSection.style.display = 'none';
    }
}

// Load admins list
async function loadAdmins() {
    const tbody = document.getElementById('admin-list-tbody');
    if (!tbody) return;
    
    try {
        const { data, error } = await supabase
            .from('user_profiles')
            .select('*')
            .in('role', ['admin', 'super_admin', 'manager'])
            .order('created_at', { ascending: false });
        
        if (error) {
            if (error.message.includes('relation "user_profiles" does not exist')) {
                tbody.innerHTML = '<tr><td colspan="5" class="empty-message">Settings tables not set up. Run settings_schema.sql</td></tr>';
                return;
            }
            throw error;
        }
        
        if (!data || data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="empty-message">No admins found. Add your first admin below.</td></tr>';
            return;
        }
        
        tbody.innerHTML = data.map(admin => `
            <tr>
                <td>${admin.full_name || 'N/A'}</td>
                <td>${admin.email || 'N/A'}</td>
                <td><span class="role-badge role-${admin.role}">${admin.role || 'user'}</span></td>
                <td><span class="status-badge status-active">Active</span></td>
                <td>
                    ${admin.user_id !== getUserId() ? `<button class="btn-secondary btn-sm" onclick="removeAdmin('${admin.user_id}')">Remove</button>` : '<span class="text-muted">You</span>'}
                </td>
            </tr>
        `).join('');
    } catch (error) {
        console.error('Error loading admins:', error);
        tbody.innerHTML = '<tr><td colspan="5" class="empty-message">Error loading admins: ' + (error.message || 'Unknown error') + '</td></tr>';
    }
}
// Add admin
async function addAdmin(email, name, role) {
    try {
        // Check if user exists by looking for their profile
        const { data: existingProfile, error: checkError } = await supabase
            .from('user_profiles')
            .select('user_id, email')
            .eq('email', email)
            .maybeSingle(); // Use maybeSingle instead of single to avoid error if not found
        
        let userId;
        
        if (existingProfile && existingProfile.user_id) {
            userId = existingProfile.user_id;
        } else {
            // User doesn't exist in profiles yet - they need to sign up first
            alert('User with this email must sign up first. Once they create an account, you can grant them admin access by adding them again.');
            return;
        }
        
        // Update user profile with admin role
        const { error: updateError } = await supabase
            .from('user_profiles')
            .upsert({
                user_id: userId,
                email: email,
                full_name: name,
                role: role,
                updated_at: new Date().toISOString()
            }, {
                onConflict: 'user_id'
            });
        
        if (updateError) throw updateError;
        
        await loadAdmins();
        document.getElementById('add-admin-modal').style.display = 'none';
        document.getElementById('add-admin-form').reset();
        alert('Admin added successfully!');
    } catch (error) {
        console.error('Error adding admin:', error);
        if (error.code === 'PGRST116' || error.message.includes('not found')) {
            alert('User with this email does not exist. They must sign up first.');
        } else {
            alert('Error adding admin: ' + (error.message || 'Unknown error'));
        }
    }
}
// Remove admin
async function removeAdmin(userId) {
    if (!confirm('Are you sure you want to remove this admin?')) return;
    
    try {
        const { error } = await supabase
            .from('user_profiles')
            .update({ role: 'user' })
            .eq('user_id', userId);
        
        if (error) throw error;
        
        await loadAdmins();
        alert('Admin removed successfully!');
    } catch (error) {
        console.error('Error removing admin:', error);
        alert('Error removing admin: ' + (error.message || 'Unknown error'));
    }
}