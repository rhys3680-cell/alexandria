import { useState } from 'react';
import type { Item } from '@alexandria/core';
import { Button } from './ui/button.js';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.js';
import { Input, Label, Textarea } from './ui/input.js';

/**
 * Correcting an item by hand.
 *
 * This is the one thing the app could not do: speech recognition puts a wrong
 * name into `people`, and the dictionary only helps the next recording. The
 * body is deliberately not editable here — it is the original capture, and
 * rewriting what was actually said is a different act from fixing a label.
 */
export function EditItemDialog({
  item,
  open,
  onOpenChange,
  onSaved,
}: {
  item: Item;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}): React.JSX.Element {
  const [title, setTitle] = useState(item.title ?? '');
  const [summary, setSummary] = useState(item.summary ?? '');
  const [tags, setTags] = useState(item.tags.join(', '));
  const [people, setPeople] = useState(item.people.join(', '));
  const [keywords, setKeywords] = useState(item.keywords.join(', '));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await window.alexandria.updateItem(item.id, {
        title: title.trim(),
        summary: summary.trim(),
        tags: splitList(tags),
        people: splitList(people),
        keywords: splitList(keywords),
      });
      await onSaved();
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby="edit-item-hint">
        <DialogHeader>
          <DialogTitle>항목 고치기</DialogTitle>
          <DialogDescription id="edit-item-hint">
            마크다운 파일에 바로 반영되고, 검색 색인도 함께 갱신됩니다. 원문은 그대로 둡니다.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="edit-title">제목</Label>
            <Input id="edit-title" value={title} onChange={(event) => setTitle(event.target.value)} />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="edit-summary">요약</Label>
            <Textarea
              id="edit-summary"
              rows={3}
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="edit-people">인물</Label>
            <Input
              id="edit-people"
              value={people}
              placeholder="쉼표로 구분"
              onChange={(event) => setPeople(event.target.value)}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="edit-tags">태그</Label>
            <Input id="edit-tags" value={tags} placeholder="쉼표로 구분" onChange={(event) => setTags(event.target.value)} />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="edit-keywords">키워드 (영어)</Label>
            <Input
              id="edit-keywords"
              value={keywords}
              placeholder="교차 언어 검색에 쓰입니다"
              onChange={(event) => setKeywords(event.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">취소</Button>
          </DialogClose>
          <Button variant="primary" disabled={saving} onClick={() => void save()}>
            {saving ? '저장 중…' : '저장'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}
