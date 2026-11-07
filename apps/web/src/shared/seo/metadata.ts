export const publicPaths = ['/', '/workshop/', '/terms/', '/privacy/'];
export function shareImage(en: boolean, origin: string) {
  return {
    url: new URL(`/og/story-archive-${en ? 'en' : 'ko'}-v1.png`, origin).href,
    alt: en ? 'Story Archive — discover, play and create interactive mystery stories.' : '스토리 아카이브 — 추리 이야기를 발견하고, 플레이하고, 창작하세요.',
    width: '1200', height: '630', type: 'image/png',
  };
}
export function siteOrigin(value?: string) {
  const url = new URL(value || 'https://mindul-murder-mystery.duckdns.org');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('PUBLIC_SITE_URL must be an HTTP(S) origin.');
  return url.origin;
}
export function pageMetadata(pathname: string) {
  const en = /^\/en(?:\/|$)/.test(pathname);
  const path = pathname.replace(/^\/en(?=\/|$)/, '').replace(/\/+$/, '') || '/';
  const brand = en ? 'Story Archive' : '스토리 아카이브';
  const pages: Record<string, [string, string]> = en ? {
    '/': ['Interactive Stories', 'Discover interactive mystery stories to enjoy alone or with friends. Explore community stories and create your own.'],
    '/workshop': ['Workshop', 'Explore community mystery stories, save favorites and start creating your own story.'],
    '/terms': ['Terms of Service', 'Read the terms for using Story Archive and its interactive story platform.'],
    '/privacy': ['Privacy Policy', 'Learn how Story Archive handles account information, guest sessions and service data.'],
    '/mypage': ['My page', 'Manage your account and stories.'],
    '/workshop/editor': ['Story editor', 'Create and edit your private story drafts.'],
  } : {
    '/': ['인터랙티브 작품', '혼자 또는 친구와 즐기는 인터랙티브 추리 이야기를 만나세요. 창작마당에서 작품을 찾고 나만의 이야기를 시작할 수 있습니다.'],
    '/workshop': ['창작마당', '다른 제작자의 추리 작품을 둘러보고 즐겨찾기에 저장하세요. 나만의 이야기도 창작마당에서 시작할 수 있습니다.'],
    '/terms': ['이용약관', '스토리 아카이브의 인터랙티브 작품과 서비스 이용에 관한 약관을 확인하세요.'],
    '/privacy': ['개인정보 처리방침', '스토리 아카이브의 계정 정보, 게스트 세션과 서비스 데이터 처리 방침을 확인하세요.'],
    '/mypage': ['마이페이지', '계정과 내가 만든 작품을 관리합니다.'],
    '/workshop/editor': ['스토리 편집기', '비공개 스토리 초안을 만들고 수정합니다.'],
  };
  const [name, description] = pages[path] ?? [en ? 'Page not found' : '페이지를 찾을 수 없음', en ? 'This page is not available.' : '요청한 페이지를 찾을 수 없습니다.'];
  const indexable = publicPaths.includes(path === '/' ? '/' : path + '/');
  const localized = (language: string) => `${language === 'en' ? '/en' : ''}${path === '/' ? '/' : path + '/'}`;
  return { title: `${name} · ${brand}`, description, brand, en, path, indexable, localized };
}
