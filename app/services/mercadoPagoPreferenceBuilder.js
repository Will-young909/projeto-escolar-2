function normalizeSiteUrl(siteUrl) {
    const value = typeof siteUrl === 'string' ? siteUrl.trim() : '';
    if (!value) return '';
    return value.replace(/\/+$/, '');
  }
  
  function buildMercadoPagoBackUrls(siteUrl, overrides = {}) {
    const baseUrl = normalizeSiteUrl(siteUrl);
    const backUrls = {};
  
    if (overrides.success || baseUrl) {
      backUrls.success = overrides.success || `${baseUrl}/pagamento/sucesso`;
    }
    if (overrides.failure || baseUrl) {
      backUrls.failure = overrides.failure || `${baseUrl}/pagamento/erro`;
    }
    if (overrides.pending || baseUrl) {
      backUrls.pending = overrides.pending || `${baseUrl}/pagamento/pendente`;
    }
  
    return backUrls;
  }
  
  function buildMercadoPagoPreference({
    items,
    siteUrl,
    successUrl,
    failureUrl,
    pendingUrl,
    external_reference,
    notification_url,
    metadata,
  }) {
    const back_urls = buildMercadoPagoBackUrls(siteUrl, {
      success: successUrl,
      failure: failureUrl,
      pending: pendingUrl,
    });
  
    const preference = {
      items,
      ...(Object.keys(back_urls).length ? { back_urls } : {}),
    };
  
    if (external_reference !== undefined && external_reference !== null) {
      preference.external_reference = external_reference;
    }
  
    if (notification_url) {
      preference.notification_url = notification_url;
    }
  
    if (metadata) {
      preference.metadata = metadata;
    }
  
    if (back_urls.success && String(back_urls.success).trim()) {
      preference.auto_return = 'approved';
    }
  
    return preference;
  }
  
  module.exports = {
    normalizeSiteUrl,
    buildMercadoPagoBackUrls,
    buildMercadoPagoPreference,
  };
  