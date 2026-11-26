// 课程卡（列表）、准备度、课程设置弹层、整理状态。
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../../api/endpoints';
import { invalidate, useApply, useCourseHome } from '../../api/hooks';
import type { Course } from '../../api/types';
import { longDate } from '../../lib/format';
import { useUi } from '../../state/ui';
import { s } from '../../strings/zh-CN';
import { Notice } from '../../ui/Blocks';
import { Button } from '../../ui/Button';
import { Tag } from '../../ui/Chip';
import { ProgressBar, Skeleton } from '../../ui/Feedback';
import { Chip } from '../../ui/Chip';
import { Segmented, Stepper, TextField } from '../../ui/Inputs';
import { MiniMap } from '../../ui/KnowledgeMap';
import { ConfirmDialog, Menu, Sheet } from '../../ui/Sheet';
import { Card, ListItem } from '../../ui/Surfaces';
import { Text } from '../../ui/Text';
import { Column, Row } from '../../layout';
import css from './course.module.css';

export function readinessText(course: Course) {
  const { mastered, total } = course.readiness;
  if (!total) return s.course.noKps;
  if (mastered >= total) return '重点全部掌握了';
  return `重点还差 ${total - mastered} 个没掌握`;
}

export function examLine(course: Course) {
  if (!course.exam_date) return '考试日期未定';
  if (course.days_left !== null && course.days_left < 0) return '考试已结束';
  return `${longDate(course.exam_date)}考试`;
}

export function CourseCard({ course }: { course: Course }) {
  const navigate = useNavigate();
  const home = useCourseHome(course.id);
  const [confirm, setConfirm] = useState(false);
  const qc = useQueryClient();
  const urgent = course.days_left !== null && course.days_left <= 3 && course.days_left >= 0;
  const organizing = course.organizing.state === 'working';
  return (
    <>
      <Card to={`/c/${course.id}`} color={course.color} transitionName={`course-${course.id}`} viewTransition label={`${course.name}，${examLine(course)}，${readinessText(course)}`}>
        <div className={css.cardTop}>
          <div className={css.cardName}>
            <Row gap={8}><Text variant="h3" nowrap>{course.name}</Text>{course.sample && <Tag>{s.course.sampleTag}</Tag>}</Row>
            <Text variant="caption" tone="secondary">{examLine(course)}</Text>
          </div>
          {course.days_left !== null && course.days_left >= 0 && (
            <span className={`${css.days} ${urgent ? css.urgent : ''}`}><span className={css.daysNum}>{course.days_left}</span><Text variant="caption" tone="secondary" as="span">天</Text></span>
          )}
          <span onClick={(e) => e.preventDefault()}>
            <Menu items={[
              { label: s.course.settings, icon: 'settings', onSelect: () => navigate(`/c/${course.id}?settings=1`) },
              { label: s.action.delete, icon: 'trash', danger: true, onSelect: () => setConfirm(true) },
            ]} />
          </span>
        </div>
        <div className={css.mini}>
          {home.data ? <MiniMap chapters={home.data.map.chapters} label={`${course.name}知识点地图缩略`} cell={7} perRow={28} /> : <Skeleton height={24} />}
        </div>
        {organizing ? (
          <Column gap={8}><Text variant="caption" tone="accent">{course.organizing.stage ?? s.course.organizing}</Text><ProgressBar value={course.organizing.progress ?? 0} label={s.course.organizing} /></Column>
        ) : course.organizing.state === 'waiting_ai' ? (
          <Text variant="caption" tone="warning">{s.course.waitingAi}</Text>
        ) : (
          <div className={css.readyLine}>
            <Text variant="bodySm" strong as="span">{course.readiness.total ? `${Math.round((course.readiness.mastered / course.readiness.total) * 100)}%` : '—'}</Text>
            <Text variant="caption" tone="secondary" as="span">{readinessText(course)}</Text>
          </div>
        )}
      </Card>
      <ConfirmDialog
        open={confirm} title={s.course.deleteTitle(course.name)} body={s.course.deleteBody} confirm={s.action.delete} danger
        onCancel={() => setConfirm(false)}
        onConfirm={async () => { setConfirm(false); await api.deleteCourse(course.id); invalidate(qc, ['courses', 'today', 'schedule']); useUi.getState().toast('已删除'); }}
      />
    </>
  );
}

export function OrganizingNotice({ course }: { course: Course }) {
  const requestConnect = useUi((st) => st.requestConnect);
  if (course.organizing.state === 'waiting_ai') {
    return (
      <Card tone="tinted">
        <Row gap={12} justify="between" wrap>
          <Text>{s.course.waitingAi}</Text>
          <Button variant="primary" size="sm" icon="key" onClick={() => void requestConnect()}>{s.ai.title}</Button>
        </Row>
      </Card>
    );
  }
  if (course.organizing.state === 'working') {
    return (
      <Column gap={8}>
        <Row justify="between"><Text variant="bodySm" tone="accent" strong>{course.organizing.stage ?? s.course.organizing}</Text><Text variant="caption" tone="tertiary">{Math.round((course.organizing.progress ?? 0) * 100)}%</Text></Row>
        <ProgressBar value={course.organizing.progress ?? 0} label={s.course.organizing} />
      </Column>
    );
  }
  if (course.organizing.state === 'attention' && course.organizing.attention) {
    return <Notice tone="warn" icon="warning">{course.organizing.attention}</Notice>;
  }
  return null;
}

export function CourseSettingsSheet({ course, open, onClose }: { course: Course; open: boolean; onClose: () => void }) {
  const apply = useApply();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState(course.name);
  const [date, setDate] = useState(course.exam_date ?? '');
  const [cap, setCap] = useState<number | null>(course.daily_cap_min);
  const [color, setColor] = useState(course.color);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await apply(() => api.updateCourse(course.id, { name: name.trim() || course.name, exam_date: date || null, daily_cap_min: cap, color }));
      onClose();
    } catch { /* 已提示 */ } finally { setBusy(false); }
  };
  return (
    <>
      <Sheet open={open} onClose={onClose} title={s.course.settings} footer={<Button variant="primary" block loading={busy} onClick={() => void save()}>{s.action.save}</Button>}>
        <Column gap={24}>
          <TextField label={s.wizard.name} value={name} onChange={setName} />
          <Column gap={8}>
            <TextField label={s.course.examDate} value={date} onChange={setDate} type="date" />
            <Row gap={8}><Chip selected={!date} onClick={() => setDate('')}>{s.course.unknownDate}</Chip></Row>
          </Column>
          <Column gap={8}>
            <Text variant="bodySm" tone="secondary">{s.course.dailyCap}</Text>
            <Row justify="between" wrap gap={12}>
              <Segmented label={s.course.dailyCap} value={cap === null ? 'auto' : 'fixed'} onChange={(v) => setCap(v === 'auto' ? null : 60)} options={[{ value: 'auto', label: s.course.auto }, { value: 'fixed', label: '上限' }]} />
              {cap !== null && <Stepper label={s.course.dailyCap} value={cap} onChange={setCap} min={15} max={300} step={15} format={(v) => `${v} 分钟`} />}
            </Row>
          </Column>
          <Column gap={8}>
            <Text variant="bodySm" tone="secondary">{s.course.color}</Text>
            <div className={css.colors} role="radiogroup" aria-label={s.course.color}>
              {Array.from({ length: 8 }, (_, i) => (
                <button key={i} type="button" role="radio" aria-checked={color === i} aria-label={`颜色 ${i + 1}`} className={css.swatch} style={{ background: `var(--course-${i})` }} onClick={() => setColor(i)} />
              ))}
            </div>
          </Column>
          <div>
            <ListItem title={s.focus.format} subtitle="题型、题量、时长" icon="mock" onClick={() => { onClose(); navigate(`/c/${course.id}/focus#format`); }} chevron />
            <ListItem title="删除课程" icon="trash" iconTone="danger" danger onClick={() => setConfirm(true)} />
          </div>
        </Column>
      </Sheet>
      <ConfirmDialog
        open={confirm} title={s.course.deleteTitle(course.name)} body={s.course.deleteBody} confirm={s.action.delete} danger onCancel={() => setConfirm(false)}
        onConfirm={async () => { setConfirm(false); onClose(); await api.deleteCourse(course.id); invalidate(qc, ['courses', 'today', 'schedule']); navigate('/courses', { replace: true }); useUi.getState().toast('已删除'); }}
      />
    </>
  );
}
