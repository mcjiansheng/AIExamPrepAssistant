ALTER TABLE courses ADD COLUMN created_at TEXT;
ALTER TABLE courses ADD COLUMN exam_date TEXT;
ALTER TABLE courses ADD COLUMN color INTEGER NOT NULL DEFAULT 0;
ALTER TABLE courses ADD COLUMN sample INTEGER NOT NULL DEFAULT 0;
ALTER TABLE courses ADD COLUMN daily_cap_min INTEGER;
ALTER TABLE courses ADD COLUMN seed_key TEXT;
UPDATE courses SET created_at = strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now') WHERE created_at IS NULL;
CREATE INDEX courses_user_exam ON courses(user_id, exam_date, created_at);

CREATE TABLE course_formats (
    course_id TEXT PRIMARY KEY REFERENCES courses(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    value TEXT NOT NULL
);

CREATE TABLE chapters (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id TEXT NOT NULL,
    title TEXT NOT NULL,
    position INTEGER NOT NULL,
    FOREIGN KEY (user_id, course_id) REFERENCES courses(user_id, id) ON DELETE CASCADE
);
CREATE INDEX chapters_course ON chapters(course_id, position);

CREATE TABLE topics (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id TEXT NOT NULL,
    chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    position INTEGER NOT NULL,
    minutes INTEGER NOT NULL,
    homework INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (user_id, course_id) REFERENCES courses(user_id, id) ON DELETE CASCADE
);
CREATE INDEX topics_course ON topics(course_id, chapter_id, position);

ALTER TABLE knowledge_points ADD COLUMN chapter_id TEXT REFERENCES chapters(id) ON DELETE CASCADE;
ALTER TABLE knowledge_points ADD COLUMN topic_id TEXT REFERENCES topics(id) ON DELETE CASCADE;
ALTER TABLE knowledge_points ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_points ADD COLUMN summary TEXT NOT NULL DEFAULT '';
ALTER TABLE knowledge_points ADD COLUMN modes TEXT NOT NULL DEFAULT '[]';
ALTER TABLE knowledge_points ADD COLUMN blocks TEXT NOT NULL DEFAULT '[]';
CREATE INDEX knowledge_points_course ON knowledge_points(course_id, chapter_id, topic_id, position);

CREATE TABLE kp_progress (
    kp_id TEXT PRIMARY KEY REFERENCES knowledge_points(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    understood_at TEXT,
    mark TEXT,
    stability REAL,
    due_at TEXT,
    last_review_at TEXT
);
CREATE INDEX kp_progress_due ON kp_progress(user_id, due_at);

CREATE TABLE materials (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id TEXT NOT NULL,
    title TEXT NOT NULL,
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    pages INTEGER,
    status TEXT NOT NULL,
    stage TEXT,
    progress REAL,
    vision TEXT NOT NULL,
    superseded_by TEXT REFERENCES materials(id) ON DELETE SET NULL,
    version_group TEXT,
    decision TEXT,
    skipped_pages TEXT NOT NULL DEFAULT '[]',
    error TEXT,
    uploaded_at TEXT NOT NULL,
    storage_extension TEXT,
    FOREIGN KEY (user_id, course_id) REFERENCES courses(user_id, id) ON DELETE CASCADE
);
CREATE INDEX materials_course ON materials(course_id, uploaded_at);

CREATE TABLE photo_links (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    FOREIGN KEY (user_id, course_id) REFERENCES courses(user_id, id) ON DELETE CASCADE
);

CREATE TABLE material_pages (
    material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    page INTEGER NOT NULL,
    title TEXT,
    text TEXT NOT NULL,
    image_path TEXT,
    PRIMARY KEY (material_id, page)
);

CREATE TABLE kp_refs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kp_id TEXT NOT NULL REFERENCES knowledge_points(id) ON DELETE CASCADE,
    material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
    page INTEGER NOT NULL,
    quote TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    UNIQUE (kp_id, material_id, page)
);
CREATE INDEX kp_refs_page ON kp_refs(material_id, page);
CREATE INDEX kp_refs_kp ON kp_refs(kp_id, position);

CREATE VIEW active_knowledge_points AS
SELECT kp.* FROM knowledge_points kp
WHERE NOT EXISTS (SELECT 1 FROM kp_refs ref WHERE ref.kp_id = kp.id)
   OR EXISTS (
        SELECT 1 FROM kp_refs ref JOIN materials m ON m.id = ref.material_id
        WHERE ref.kp_id = kp.id AND m.superseded_by IS NULL
   );

CREATE TABLE fragments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id TEXT NOT NULL,
    text TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'text',
    analyzed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id, course_id) REFERENCES courses(user_id, id) ON DELETE CASCADE
);
CREATE INDEX fragments_course ON fragments(course_id, created_at);

CREATE TABLE focus_matches (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    fragment_id TEXT NOT NULL REFERENCES fragments(id) ON DELETE CASCADE,
    kp_id TEXT NOT NULL REFERENCES knowledge_points(id) ON DELETE CASCADE,
    level TEXT NOT NULL,
    certainty TEXT NOT NULL,
    user_choice INTEGER,
    UNIQUE (fragment_id, kp_id)
);
CREATE INDEX focus_matches_kp ON focus_matches(kp_id);

CREATE TABLE focus_conflicts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id TEXT NOT NULL,
    kp_id TEXT NOT NULL UNIQUE REFERENCES knowledge_points(id) ON DELETE CASCADE,
    choice TEXT,
    FOREIGN KEY (user_id, course_id) REFERENCES courses(user_id, id) ON DELETE CASCADE
);

CREATE TABLE bank_questions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id TEXT NOT NULL,
    kp_id TEXT NOT NULL REFERENCES knowledge_points(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    score REAL NOT NULL,
    stem TEXT NOT NULL,
    options TEXT,
    answer TEXT NOT NULL,
    solution TEXT NOT NULL,
    hints TEXT NOT NULL,
    refs TEXT NOT NULL,
    authored INTEGER NOT NULL DEFAULT 0,
    check_state TEXT NOT NULL,
    check_note TEXT,
    FOREIGN KEY (user_id, course_id) REFERENCES courses(user_id, id) ON DELETE CASCADE
);
CREATE INDEX bank_questions_kp ON bank_questions(kp_id, authored DESC);
CREATE INDEX bank_questions_course ON bank_questions(course_id, check_state);

ALTER TABLE practice_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'quick';
ALTER TABLE practice_sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'preparing';
ALTER TABLE practice_sessions ADD COLUMN created_at TEXT;
ALTER TABLE practice_sessions ADD COLUMN started_at TEXT;
ALTER TABLE practice_sessions ADD COLUMN finished_at TEXT;
ALTER TABLE practice_sessions ADD COLUMN question_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE practice_sessions ADD COLUMN answered INTEGER NOT NULL DEFAULT 0;
ALTER TABLE practice_sessions ADD COLUMN score REAL;
ALTER TABLE practice_sessions ADD COLUMN total REAL NOT NULL DEFAULT 0;
CREATE INDEX practice_sessions_course ON practice_sessions(user_id, course_id, created_at);

CREATE TABLE learning_events (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kp_id TEXT NOT NULL REFERENCES knowledge_points(id) ON DELETE CASCADE,
    bank_id TEXT NOT NULL REFERENCES bank_questions(id) ON DELETE CASCADE,
    session_id TEXT REFERENCES practice_sessions(id) ON DELETE CASCADE,
    outcome TEXT NOT NULL,
    counted INTEGER NOT NULL,
    hinted INTEGER NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX learning_events_kp ON learning_events(kp_id, created_at);

CREATE TABLE mistakes (
    bank_id TEXT PRIMARY KEY REFERENCES bank_questions(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id TEXT NOT NULL,
    wrong_count INTEGER NOT NULL,
    correct_streak INTEGER NOT NULL,
    last_wrong_at TEXT NOT NULL,
    reason TEXT NOT NULL,
    question_id TEXT,
    FOREIGN KEY (user_id, course_id) REFERENCES courses(user_id, id) ON DELETE CASCADE
);
CREATE INDEX mistakes_course ON mistakes(user_id, course_id, last_wrong_at);

CREATE TABLE chat_threads (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id TEXT,
    title TEXT NOT NULL,
    kind TEXT NOT NULL,
    model TEXT,
    updated_at TEXT NOT NULL,
    preview TEXT,
    FOREIGN KEY (user_id, course_id) REFERENCES courses(user_id, id) ON DELETE CASCADE
);
CREATE INDEX chat_threads_user ON chat_threads(user_id, updated_at);
CREATE UNIQUE INDEX chat_threads_one_global ON chat_threads(user_id) WHERE kind = 'global';

CREATE TRIGGER invalidate_courses_update_undo AFTER UPDATE ON courses BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'courses' AND row_key = NEW.id
    );
END;

CREATE TRIGGER invalidate_courses_delete_undo AFTER DELETE ON courses BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'courses' AND row_key = OLD.id
    );
END;

CREATE TRIGGER invalidate_courses_insert_undo AFTER INSERT ON courses BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'courses' AND row_key = NEW.id
    );
END;

CREATE TRIGGER invalidate_course_formats_update_undo AFTER UPDATE ON course_formats BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'course_formats' AND row_key = NEW.course_id
    );
END;

CREATE TRIGGER invalidate_course_formats_delete_undo AFTER DELETE ON course_formats BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'course_formats' AND row_key = OLD.course_id
    );
END;

CREATE TRIGGER invalidate_course_formats_insert_undo AFTER INSERT ON course_formats BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'course_formats' AND row_key = NEW.course_id
    );
END;

CREATE TRIGGER invalidate_materials_update_undo AFTER UPDATE ON materials BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'materials' AND row_key = NEW.id
    );
END;

CREATE TRIGGER invalidate_materials_delete_undo AFTER DELETE ON materials BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'materials' AND row_key = OLD.id
    );
END;

CREATE TRIGGER invalidate_materials_insert_undo AFTER INSERT ON materials BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'materials' AND row_key = NEW.id
    );
END;

CREATE TRIGGER invalidate_fragments_update_undo AFTER UPDATE ON fragments BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'fragments' AND row_key = NEW.id
    );
END;

CREATE TRIGGER invalidate_fragments_delete_undo AFTER DELETE ON fragments BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'fragments' AND row_key = OLD.id
    );
END;

CREATE TRIGGER invalidate_fragments_insert_undo AFTER INSERT ON fragments BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'fragments' AND row_key = NEW.id
    );
END;

CREATE TRIGGER invalidate_focus_matches_update_undo AFTER UPDATE ON focus_matches BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'focus_matches' AND row_key = NEW.id
    );
END;

CREATE TRIGGER invalidate_focus_matches_delete_undo AFTER DELETE ON focus_matches BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'focus_matches' AND row_key = OLD.id
    );
END;

CREATE TRIGGER invalidate_focus_matches_insert_undo AFTER INSERT ON focus_matches BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'focus_matches' AND row_key = NEW.id
    );
END;

CREATE TRIGGER invalidate_focus_conflicts_update_undo AFTER UPDATE ON focus_conflicts BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'focus_conflicts' AND row_key = NEW.id
    );
END;

CREATE TRIGGER invalidate_focus_conflicts_delete_undo AFTER DELETE ON focus_conflicts BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'focus_conflicts' AND row_key = OLD.id
    );
END;

CREATE TRIGGER invalidate_focus_conflicts_insert_undo AFTER INSERT ON focus_conflicts BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'focus_conflicts' AND row_key = NEW.id
    );
END;

CREATE TRIGGER invalidate_kp_refs_update_undo AFTER UPDATE ON kp_refs BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'kp_refs' AND row_key = NEW.id
    );
END;

CREATE TRIGGER invalidate_kp_refs_delete_undo AFTER DELETE ON kp_refs BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'kp_refs' AND row_key = OLD.id
    );
END;

CREATE TRIGGER invalidate_kp_refs_insert_undo AFTER INSERT ON kp_refs BEGIN
    UPDATE undos SET state = 'expired' WHERE state = 'active' AND id IN (
        SELECT undo_id FROM undo_rows WHERE table_name = 'kp_refs' AND row_key = NEW.id
    );
END;
