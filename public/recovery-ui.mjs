// Recovery UI never receives or renders the tokens contained in an email link.
export function mountRecoveryRequest({container,api,introHtml,onBack,isCurrent,email=''}) {
  container.innerHTML=`<section class="admin-shell">${introHtml}<div class="recovery-layout login-form"><h2>Recuperar acesso</h2><p>Informe seu e-mail para receber um link e definir uma nova senha.</p><form id="recovery-request-form"><label for="recovery-email">E-mail de administrador</label><input id="recovery-email" type="email" autocomplete="email" maxlength="254" required placeholder="seu@email.com"><p id="recovery-request-error" class="error-text" role="alert"></p><p id="recovery-request-status" class="recovery-status" role="status"></p><button class="button primary" id="send-recovery" type="submit">Enviar link de recuperação</button></form><button class="text-link recovery-back" id="recovery-back" type="button">Voltar para o login</button></div></section>`;
  const form=container.querySelector('#recovery-request-form');
  const input=container.querySelector('#recovery-email');input.value=email;
  const button=container.querySelector('#send-recovery');
  const error=container.querySelector('#recovery-request-error');
  const status=container.querySelector('#recovery-request-status');
  container.querySelector('#recovery-back').addEventListener('click',onBack);
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(button.disabled)return;
    button.disabled=true;error.textContent='';status.textContent='';
    try {
      await api('/api/admin/recover',{method:'POST',body:{email:input.value.trim()}});
      if(isCurrent())status.textContent='Se houver uma conta para este e-mail, você receberá um link para definir a senha. Confira também a pasta de spam.';
    }catch(failure){if(isCurrent())error.textContent=failure.message;}
    finally{if(isCurrent())button.disabled=false;}
  });
}

export async function mountRecoveryPassword({container,api,introHtml,onSuccess,onRequest,isCurrent,expired=false}) {
  container.innerHTML=`<section class="admin-shell">${introHtml}<div class="recovery-layout initial-loading" role="status">Verificando o link de recuperação…</div></section>`;
  let session;
  try { session=await api('/api/admin/recovery-session'); }
  catch(error){
    if(!isCurrent())return;
    if(expired || [400,401,403].includes(error.status)) session={authenticated:false};
    else {
      container.innerHTML=`<section class="admin-shell">${introHtml}<div class="recovery-layout login-form"><h2>Não foi possível verificar o link</h2><p id="recovery-load-error" class="error-text" role="alert"></p><button class="button primary" id="new-recovery-link" type="button">Solicitar novo link</button></div></section>`;
      container.querySelector('#recovery-load-error').textContent=error.message;
      container.querySelector('#new-recovery-link').addEventListener('click',onRequest);return;
    }
  }
  if(!isCurrent())return;
  if(expired || !session.authenticated) {
    container.innerHTML=`<section class="admin-shell">${introHtml}<div class="recovery-layout login-form"><h2>Link inválido ou expirado</h2><p>Solicite um novo e-mail e abra o link mais recente para definir sua senha.</p><button class="button primary" id="new-recovery-link" type="button">Solicitar novo link</button></div></section>`;
    container.querySelector('#new-recovery-link').addEventListener('click',onRequest);return;
  }
  container.innerHTML=`<section class="admin-shell">${introHtml}<div class="recovery-layout login-form"><h2>Definir nova senha</h2><p>Escolha uma senha com pelo menos 8 caracteres para o seu acesso.</p><form id="recovery-password-form"><label for="new-password">Nova senha</label><input id="new-password" type="password" autocomplete="new-password" minlength="8" maxlength="1024" required><label for="confirm-password">Confirmar nova senha</label><input id="confirm-password" type="password" autocomplete="new-password" minlength="8" maxlength="1024" required><p id="recovery-password-error" class="error-text" role="alert"></p><button class="button primary" id="save-recovery-password" type="submit">Salvar nova senha</button></form><button class="text-link recovery-back" id="recovery-request-again" type="button">Solicitar novo link</button></div></section>`;
  const form=container.querySelector('#recovery-password-form');
  const password=container.querySelector('#new-password'),confirmation=container.querySelector('#confirm-password');
  const error=container.querySelector('#recovery-password-error'),button=container.querySelector('#save-recovery-password');
  container.querySelector('#recovery-request-again').addEventListener('click',()=>{if(button.disabled)return;password.value='';confirmation.value='';onRequest();});
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(button.disabled)return;
    error.textContent='';
    if(password.value!==confirmation.value){error.textContent='As senhas não coincidem. Confira a confirmação.';confirmation.focus();return;}
    button.disabled=true;
    try {
      await api('/api/admin/password',{method:'POST',body:{password:password.value}});
      password.value='';confirmation.value='';
      if(isCurrent())onSuccess();
    }catch(failure){if(isCurrent())error.textContent=failure.message;}
    finally{if(isCurrent())button.disabled=false;}
  });
}
