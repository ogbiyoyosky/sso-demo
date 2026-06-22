<#--
  Standalone custom sign-in page for the "promoting-queens" theme.

  This is intentionally a COMPLETE HTML document rather than an extension of the
  parent theme's template macros — that makes the look 100% ours and removes any
  dependency on Keycloak's internal template contract. The only things that MUST
  stay are the FreeMarker bindings that wire the form to Keycloak:
    • the form posts to ${url.loginAction}
    • the fields are named exactly "username", "password", "rememberMe"
    • the social/IdP buttons link to ${p.loginUrl}
    • the register link goes to ${url.registrationUrl}
  Change the chrome however you like; keep those and authentication still works.
-->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in · Promoting Queens</title>
  <link rel="stylesheet" href="${url.resourcesPath}/css/styles.css">
</head>
<body class="pq-body">
  <div class="pq-split">
    <aside class="pq-brand">
      <div class="pq-brand-inner">
        <div class="pq-logo">♛</div>
        <h1>Promoting&nbsp;Queens</h1>
        <p>One account for staff and members.</p>
      </div>
      <div class="pq-brand-foot">Secured by single sign-on</div>
    </aside>

    <main class="pq-panel">
      <div class="pq-card">
        <h2>Welcome back</h2>
        <p class="pq-sub">Sign in to continue</p>

        <#if message?? && (message.summary)?has_content>
          <div class="pq-alert pq-alert-${(message.type)!'info'}">
            ${kcSanitize(message.summary)?no_esc}
          </div>
        </#if>

        <#if realm.password>
        <form class="pq-form" action="${url.loginAction}" method="post" novalidate>
          <label for="username">Email</label>
          <input id="username" name="username" type="text" autofocus
                 value="${(login.username)!''}" autocomplete="username"
                 class="pq-input <#if messagesPerField.existsError('username','password')>pq-input-error</#if>" />

          <label for="password">Password</label>
          <input id="password" name="password" type="password" autocomplete="current-password"
                 class="pq-input <#if messagesPerField.existsError('username','password')>pq-input-error</#if>" />

          <#if messagesPerField.existsError('username','password')>
            <span class="pq-field-error">${kcSanitize(messagesPerField.getFirstError('username','password'))?no_esc}</span>
          </#if>

          <div class="pq-row">
            <#if realm.rememberMe && !usernameHidden??>
              <label class="pq-check">
                <input type="checkbox" name="rememberMe" <#if login.rememberMe??>checked</#if>> Remember me
              </label>
            <#else>
              <span></span>
            </#if>
            <#if realm.resetPasswordAllowed>
              <a class="pq-link" href="${url.loginResetCredentialsUrl}">Forgot password?</a>
            </#if>
          </div>

          <button class="pq-btn" type="submit">Sign in</button>
        </form>
        </#if>

        <#if social.providers?? && social.providers?has_content>
          <div class="pq-divider"><span>or continue with</span></div>
          <div class="pq-social">
            <#list social.providers as p>
              <a class="pq-btn pq-btn-social" href="${p.loginUrl}" id="social-${p.alias}">
                <span class="pq-ms-mark"></span> ${p.displayName!p.alias}
              </a>
            </#list>
          </div>
        </#if>

        <#if realm.registrationAllowed && !registrationDisabled??>
          <p class="pq-foot">New member? <a class="pq-link" href="${url.registrationUrl}">Create an account</a></p>
        </#if>
      </div>
    </main>
  </div>
</body>
</html>
