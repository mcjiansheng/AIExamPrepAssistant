CREATE TABLE schedule_items (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id TEXT NOT NULL,
    date TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    minutes INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'todo',
    reason TEXT NOT NULL,
    moved_from TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    kp_ids TEXT NOT NULL DEFAULT '[]',
    session_id TEXT REFERENCES practice_sessions(id) ON DELETE SET NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id, course_id) REFERENCES courses(user_id, id) ON DELETE CASCADE
);
CREATE INDEX schedule_items_user_date ON schedule_items(user_id, date, status, position);

CREATE TABLE schedule_day_budget (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    minutes INTEGER NOT NULL,
    UNIQUE (user_id, date)
);

CREATE TABLE plan_days (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    planned_on TEXT,
    notice TEXT,
    notice_seen INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE practice_sessions ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
ALTER TABLE practice_sessions ADD COLUMN time_limit_min INTEGER;
ALTER TABLE practice_sessions ADD COLUMN task_id TEXT REFERENCES schedule_items(id) ON DELETE SET NULL;
ALTER TABLE practice_sessions ADD COLUMN job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL;
ALTER TABLE practice_sessions ADD COLUMN result TEXT;

CREATE TABLE practice_questions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES practice_sessions(id) ON DELETE CASCADE,
    course_id TEXT NOT NULL,
    kp_id TEXT NOT NULL REFERENCES knowledge_points(id) ON DELETE CASCADE,
    bank_id TEXT REFERENCES bank_questions(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    type TEXT NOT NULL,
    score REAL NOT NULL,
    status TEXT NOT NULL,
    check_state TEXT NOT NULL,
    check_note TEXT,
    replaced INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    hints TEXT NOT NULL DEFAULT '[]',
    peeked INTEGER NOT NULL DEFAULT 0,
    attempt TEXT,
    UNIQUE (session_id, position),
    FOREIGN KEY (user_id, course_id) REFERENCES courses(user_id, id) ON DELETE CASCADE
);
CREATE INDEX practice_questions_kp ON practice_questions(user_id, kp_id, session_id);

CREATE TABLE question_reports (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL REFERENCES practice_questions(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL
);

ALTER TABLE learning_events ADD COLUMN question_id TEXT REFERENCES practice_questions(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX learning_events_question ON learning_events(question_id) WHERE question_id IS NOT NULL;

ALTER TABLE learning_activity ADD COLUMN course_id TEXT REFERENCES courses(id) ON DELETE CASCADE;
CREATE INDEX learning_activity_course ON learning_activity(course_id, created_at);

CREATE TABLE readiness_snapshots (
    course_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    ratio REAL NOT NULL,
    PRIMARY KEY (course_id, date),
    FOREIGN KEY (user_id, course_id) REFERENCES courses(user_id, id) ON DELETE CASCADE
);

CREATE TRIGGER invalidate_schedule_items_update_undo AFTER UPDATE ON schedule_items BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'schedule_items' AND row_key = NEW.id
    );
END;

CREATE TRIGGER invalidate_schedule_items_delete_undo AFTER DELETE ON schedule_items BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'schedule_items' AND row_key = OLD.id
    );
END;

CREATE TRIGGER invalidate_schedule_items_insert_undo AFTER INSERT ON schedule_items BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'schedule_items' AND row_key = NEW.id
    );
END;

CREATE TRIGGER invalidate_schedule_day_budget_update_undo AFTER UPDATE ON schedule_day_budget BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'schedule_day_budget' AND row_key = NEW.id
    );
END;

CREATE TRIGGER invalidate_schedule_day_budget_delete_undo AFTER DELETE ON schedule_day_budget BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'schedule_day_budget' AND row_key = OLD.id
    );
END;

CREATE TRIGGER invalidate_schedule_day_budget_insert_undo AFTER INSERT ON schedule_day_budget BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'schedule_day_budget' AND row_key = NEW.id
    );
END;

CREATE TRIGGER invalidate_plan_days_update_undo AFTER UPDATE ON plan_days BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'plan_days' AND row_key = NEW.user_id
    );
END;

CREATE TRIGGER invalidate_plan_days_delete_undo AFTER DELETE ON plan_days BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'plan_days' AND row_key = OLD.user_id
    );
END;

CREATE TRIGGER invalidate_plan_days_insert_undo AFTER INSERT ON plan_days BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'plan_days' AND row_key = NEW.user_id
    );
END;

CREATE TRIGGER invalidate_kp_progress_update_undo AFTER UPDATE ON kp_progress BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'kp_progress' AND row_key = NEW.kp_id
    );
END;

CREATE TRIGGER invalidate_kp_progress_delete_undo AFTER DELETE ON kp_progress BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'kp_progress' AND row_key = OLD.kp_id
    );
END;

CREATE TRIGGER invalidate_kp_progress_insert_undo AFTER INSERT ON kp_progress BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'kp_progress' AND row_key = NEW.kp_id
    );
END;

CREATE TRIGGER invalidate_mistakes_update_undo AFTER UPDATE ON mistakes BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'mistakes' AND row_key = NEW.bank_id
    );
END;

CREATE TRIGGER invalidate_mistakes_delete_undo AFTER DELETE ON mistakes BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'mistakes' AND row_key = OLD.bank_id
    );
END;

CREATE TRIGGER invalidate_mistakes_insert_undo AFTER INSERT ON mistakes BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'mistakes' AND row_key = NEW.bank_id
    );
END;

CREATE TRIGGER invalidate_learning_activity_update_undo AFTER UPDATE ON learning_activity BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'learning_activity' AND row_key = NEW.id
    );
END;

CREATE TRIGGER invalidate_learning_activity_delete_undo AFTER DELETE ON learning_activity BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'learning_activity' AND row_key = OLD.id
    );
END;

CREATE TRIGGER invalidate_learning_activity_insert_undo AFTER INSERT ON learning_activity BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'learning_activity' AND row_key = NEW.id
    );
END;
