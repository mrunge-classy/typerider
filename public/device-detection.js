/* Typerider · device detection: identify if user is on mobile or desktop */
(function () {
  'use strict';

  /**
   * Detect device type using multiple signals:
   * 1. Touch capability (navigator.maxTouchPoints, ontouchstart)
   * 2. User-Agent parsing
   * 3. Screen size heuristics
   * 4. Platform info
   */
  function detectDeviceType() {
    var ua = navigator.userAgent.toLowerCase();
    
    // Direct mobile indicators in user-agent
    var mobilePatterns = /mobile|android|iphone|ipad|ipod|blackberry|windows phone|opera mini/i;
    if (mobilePatterns.test(ua)) {
      return 'mobile';
    }
    
    // Check touch capability
    var maxTouchPoints = navigator.maxTouchPoints || navigator.msMaxTouchPoints || 0;
    var hasTouch = typeof ontouchstart !== 'undefined' || maxTouchPoints > 0;
    
    // Screen size heuristic: screens under 768px width are typically mobile
    var narrowScreen = window.innerWidth < 768;
    
    // Combine signals
    if (hasTouch && narrowScreen) {
      return 'mobile';
    }
    
    // Default to desktop
    return 'desktop';
  }

  /**
   * Validate device type on client to detect tampering
   * Returns confidence level: 'high', 'medium', or 'low'
   */
  function validateDeviceType(claimedType) {
    var detected = detectDeviceType();
    var confidence = 'high';
    
    // If claimed type matches detected type, confidence is high
    if (claimedType === detected) {
      return { valid: true, confidence: 'high', detected: detected };
    }
    
    // Mobile claims desktop: check if enough "desktop signals" are present
    if (claimedType === 'desktop' && detected === 'mobile') {
      // Could be a tablet or someone on a phone browser with keyboard
      var screen = {
        width: window.innerWidth,
        height: window.innerHeight,
        pixelRatio: window.devicePixelRatio || 1
      };
      
      // Tablets often have larger screens
      if (screen.width > 600) {
        confidence = 'medium';
      } else {
        confidence = 'low';
      }
      return { valid: false, confidence: confidence, detected: detected, screen: screen };
    }
    
    // Desktop claims mobile: very unlikely, high suspicion
    if (claimedType === 'mobile' && detected === 'desktop') {
      return { valid: false, confidence: 'high', detected: detected };
    }
    
    return { valid: true, confidence: 'high', detected: detected };
  }

  /**
   * Generate device fingerprint for additional security
   * Combines multiple device characteristics
   */
  function generateDeviceFingerprint() {
    var fp = {
      ua: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      screenWidth: screen.width,
      screenHeight: screen.height,
      screenColorDepth: screen.colorDepth,
      timezoneOffset: new Date().getTimezoneOffset(),
      hardwareConcurrency: navigator.hardwareConcurrency || 'unknown',
      deviceMemory: navigator.deviceMemory || 'unknown',
      maxTouchPoints: navigator.maxTouchPoints || 0
    };
    
    // Simple hash for comparison (not cryptographic)
    var str = JSON.stringify(fp);
    var hash = 0;
    for (var i = 0; i < str.length; i++) {
      var char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16);
  }

  // Export to global scope
  window.TYPERIDER_DEVICE = {
    detectDeviceType: detectDeviceType,
    validateDeviceType: validateDeviceType,
    generateDeviceFingerprint: generateDeviceFingerprint,
    current: detectDeviceType()
  };

})();
