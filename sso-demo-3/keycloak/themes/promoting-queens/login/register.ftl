<#--
  Standalone custom registration page. Same idea as login.ftl: full custom HTML,
  with the Keycloak-required bindings preserved:
    • posts to ${url.registrationAction}
    • field names: firstName, lastName, email, (username), password, password-confirm
  Because the realm has registrationEmailAsUsername=true, the username field is
  hidden and the email doubles as the username.
-->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Create account · Promoting Queens</title>
  <link rel="stylesheet" href="${url.resourcesPath}/css/styles.css">
</head>
<body class="pq-body">
  <div class="pq-split">
    <aside class="pq-brand">
      <div class="pq-brand-inner">
        <div class="pq-logo">♛</div>
        <h1>Promoting&nbsp;Queens</h1>
        <p>Join as a member in under a minute.</p>
      </div>
      <div class="pq-brand-foot">Staff? Use “Continue with Microsoft” on the sign-in page.</div>
    </aside>

    <main class="pq-panel">
      <div class="pq-card">
        <h2>Create your account</h2>
        <p class="pq-sub">Members sign up with email &amp; password</p>

        <#if message?? && (message.summary)?has_content>
          <div class="pq-alert pq-alert-${(message.type)!'info'}">
            ${kcSanitize(message.summary)?no_esc}
          </div>
        </#if>

        <form class="pq-form" action="${url.registrationAction}" method="post" novalidate>
          <div class="pq-grid2">
            <div class="pq-field">
              <label for="firstName">First name</label>
              <input id="firstName" name="firstName" type="text" value="${(register.formData.firstName!'')}"
                     class="pq-input <#if messagesPerField.existsError('firstName')>pq-input-error</#if>" />
              <#if messagesPerField.existsError('firstName')>
                <span class="pq-field-error">${kcSanitize(messagesPerField.get('firstName'))?no_esc}</span>
              </#if>
            </div>
            <div class="pq-field">
              <label for="lastName">Last name</label>
              <input id="lastName" name="lastName" type="text" value="${(register.formData.lastName!'')}"
                     class="pq-input <#if messagesPerField.existsError('lastName')>pq-input-error</#if>" />
              <#if messagesPerField.existsError('lastName')>
                <span class="pq-field-error">${kcSanitize(messagesPerField.get('lastName'))?no_esc}</span>
              </#if>
            </div>
          </div>

          <label for="email">Email</label>
          <input id="email" name="email" type="email" value="${(register.formData.email!'')}"
                 class="pq-input <#if messagesPerField.existsError('email')>pq-input-error</#if>" />
          <#if messagesPerField.existsError('email')>
            <span class="pq-field-error">${kcSanitize(messagesPerField.get('email'))?no_esc}</span>
          </#if>

          <#if !realm.registrationEmailAsUsername>
            <label for="username">Username</label>
            <input id="username" name="username" type="text" value="${(register.formData.username!'')}"
                   class="pq-input <#if messagesPerField.existsError('username')>pq-input-error</#if>" />
            <#if messagesPerField.existsError('username')>
              <span class="pq-field-error">${kcSanitize(messagesPerField.get('username'))?no_esc}</span>
            </#if>
          </#if>

          <#if (passwordRequired!true)>
            <div class="pq-grid2">
              <div class="pq-field">
                <label for="password">Password</label>
                <input id="password" name="password" type="password" autocomplete="new-password"
                       class="pq-input <#if messagesPerField.existsError('password','password-confirm')>pq-input-error</#if>" />
                <#if messagesPerField.existsError('password')>
                  <span class="pq-field-error">${kcSanitize(messagesPerField.get('password'))?no_esc}</span>
                </#if>
              </div>
              <div class="pq-field">
                <label for="password-confirm">Confirm</label>
                <input id="password-confirm" name="password-confirm" type="password" autocomplete="new-password"
                       class="pq-input <#if messagesPerField.existsError('password-confirm')>pq-input-error</#if>" />
                <#if messagesPerField.existsError('password-confirm')>
                  <span class="pq-field-error">${kcSanitize(messagesPerField.get('password-confirm'))?no_esc}</span>
                </#if>
              </div>
            </div>
          </#if>

          <button class="pq-btn" type="submit">Create account</button>
        </form>

        <p class="pq-foot">Already have an account? <a class="pq-link" href="${url.loginUrl}">Sign in</a></p>
      </div>
    </main>
  </div>
</body>
</html>
