// 原页浏览器（/m/:mid/p/:page）：从知识点页、出处跳来时定位到页并高亮引文。
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { usePage } from '../api/hooks';
import { PageBrowser } from '../features/materials/PageBrowser';
import { Page } from '../ui/Page';

export function PageViewerPage() {
  const { mid = '', page = '1' } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const n = Number(page) || 1;
  const current = usePage(mid, n);
  const courseId = params.get('c');
  return (
    <Page back={courseId ? `/c/${courseId}/materials` : true} title={current.data?.material_title.replace(/\.\w+$/, '') ?? ' '} width="reading">
      <PageBrowser
        materialId={mid} page={n} quote={params.get('q')} courseId={courseId}
        onPage={(p) => navigate(`/m/${mid}/p/${p}${courseId ? `?c=${courseId}` : ''}`, { replace: true })}
      />
    </Page>
  );
}
