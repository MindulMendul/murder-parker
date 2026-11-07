<script lang="ts">
  import { TextInput, Button } from "../../shared/ui";
  let { value = $bindable(''), locale, id = 'account-nickname', busy = false }: {
    value?: string; locale: 'ko' | 'en'; id?: string; busy?: boolean;
  } = $props();
  let message = $state(''), checking = $state(false);
  const label = (ko: string, en: string) => locale === 'en' ? en : ko;
  async function check() {
    const checked = value;
    checking = true; message = '';
    try {
      const response = await fetch(`/api/platform/nicknames/availability?nickname=${encodeURIComponent(checked)}`);
      const data = await response.json();
      if (checked !== value) return;
      if (response.status === 429) { message = label('요청이 많아요. 잠시 후 다시 확인해 주세요.', 'Too many requests. Please try again shortly.'); return; }
      message = !response.ok ? data.error : data.available ? label('사용할 수 있는 닉네임이에요.', 'This nickname is available.') : label('이미 사용 중인 닉네임이에요.', 'This nickname is already in use.');
    } catch { message = label('연결을 확인해 주세요.', 'Check your connection.'); }
    finally { checking = false; }
  }
</script>
<label class="input-label" for={id}>{label('닉네임', 'Nickname')}</label>
<TextInput {id} bind:value maxlength={20} required autocomplete="nickname" aria-describedby={`${id}-hint`} oninput={() => message = ''} />
<p class="fine" id={`${id}-hint`}>{label('문자·숫자·밑줄 2~10자 / 영문·숫자·밑줄만 사용하면 4~20자. 대소문자를 구분하지 않아요.', '2–10 letters, digits or underscores; 4–20 for ASCII names. Names are case insensitive.')}</p>
<Button variant="secondary" disabled={busy || checking || !value.trim()} onclick={check}>{label('중복 확인', 'Check availability')}</Button>
<p role="status" aria-live="polite">{message}</p>
