// 课程列表：每门课还差多少（06 第 4 节）。按考试日期排序，卡片点开放大成课程主页（M1）。
import { useCourses } from '../api/hooks';
import { usePageContext } from '../features/assistant/context';
import { CourseCard } from '../features/course/CourseParts';
import { s } from '../strings/zh-CN';
import { Button } from '../ui/Button';
import { EmptyState, ErrorState, Skeleton } from '../ui/Feedback';
import { Page } from '../ui/Page';
import { Grid } from '../layout';

export function CoursesPage() {
  const courses = useCourses();
  usePageContext({ route: '/courses', chips: [] });
  return (
    <Page title={s.course.list} large actions={<Button variant="primary" icon="plus" to="/courses/new">{s.action.addCourse}</Button>}>
      {courses.isError ? <ErrorState error={courses.error} onRetry={() => void courses.refetch()} />
        : courses.isLoading ? <Grid minItem={300} gap={12}>{[0, 1, 2].map((i) => <Skeleton key={i} height={176} radius={16} />)}</Grid>
        : courses.data!.length === 0 ? <EmptyState icon="courses" title="还没有课程" action={<Button variant="primary" icon="plus" to="/courses/new">{s.action.addCourse}</Button>} />
        : <Grid minItem={300} gap={12}>{courses.data!.map((c) => <CourseCard key={c.id} course={c} />)}</Grid>}
    </Page>
  );
}
