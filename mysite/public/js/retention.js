// retention.js — data-retention and erasure engine.
//
// BookWare stores student personal data (names, school emails, and a per-book
// borrowing record) inside each teacher's own document tree. Those are student
// education records, so they need a defined lifetime rather than living forever
// by default. This module is the single place that lifetime is defined and
// enforced.
//
// ── IMPORTANT ARCHITECTURAL LIMITATION ──────────────────────────────────────
// BookWare has no server and no Cloud Functions — everything runs in the
// browser. That means these purges are *opportunistic*: they run when a teacher
// or admin opens their portal, not on a timer. A teacher who never logs in
// again leaves their data un-purged.
//
// So deletion is only half the control. The other half lives in
// firestore.rules, which independently refuses to serve a class roster once its
// last-day-of-school date has passed. Rules are evaluated server-side on every
// request, so the ACCESS cutoff holds even when the purge has not run yet.
// Deletion catches up the next time someone signs in.
//
// If guaranteed on-time deletion is ever required (e.g. a district DPA demands
// it), this logic needs to move to a scheduled Cloud Function. See PRIVACY.md.

import {
  doc, getDocs, deleteDoc, updateDoc,
  collection, query, where, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ── Policy constants ─────────────────────────────────────────────────────────

/** How long a completed checkout record may be kept, in days.
 *  2 years — long enough for a teacher to reference last year's reading, short
 *  enough that records don't follow a student through their whole schooling. */
export const HISTORY_RETENTION_DAYS = 730;

/** Grace period after the last day of school before a roster is purged. Set to
 *  0: the point of the control is that access ends ON the last day. */
export const ROSTER_GRACE_DAYS = 0;

const DAY_MS = 86400000;

/** Cutoff Date for checkout history — anything older than this is expired. */
export function historyCutoff(now = new Date()) {
  return new Date(now.getTime() - HISTORY_RETENTION_DAYS * DAY_MS);
}

/** Parse a stored `endDate` (Firestore Timestamp | Date | 'YYYY-MM-DD') into a
 *  Date at the END of that day, so "last day of school" includes that whole
 *  day. Returns null when unset or unparseable. */
export function endOfSchoolDay(endDate) {
  if (!endDate) return null;
  let d;
  if (typeof endDate?.toDate === 'function') d = endDate.toDate();
  else if (endDate instanceof Date)          d = endDate;
  else if (typeof endDate === 'string') {
    // Parse as local, not UTC — `new Date('2026-06-04')` is UTC midnight, which
    // is the previous evening in Ohio and would expire a class a day early.
    const [y, m, dd] = endDate.split('-').map(Number);
    if (!y || !m || !dd) return null;
    d = new Date(y, m - 1, dd);
  } else return null;
  if (isNaN(d.getTime())) return null;
  d.setHours(23, 59, 59, 999);
  return d;
}

/** True when a class's last day of school has passed. */
export function isClassExpired(endDate, now = new Date()) {
  const end = endOfSchoolDay(endDate);
  if (!end) return false; // no date set → never auto-expires (teacher is prompted instead)
  return now.getTime() > end.getTime() + ROSTER_GRACE_DAYS * DAY_MS;
}

// ── Purge: checkout history past the retention window ────────────────────────

/** Delete this teacher's checkout-history entries older than the retention
 *  window. Only *closed* loans are purged — a book still physically out is an
 *  active record, not history, and deleting it would lose track of the book.
 *  Returns the number of records deleted. */
export async function purgeExpiredHistory(db, teacherUid) {
  const cutoff = historyCutoff();
  let deleted = 0;
  try {
    // Filter by dateOut server-side rather than fetching the whole history
    // collection and filtering in the browser — this ran on every single
    // portal load, so for a teacher with years of records it was the single
    // slowest thing blocking first paint. A single inequality needs no
    // composite index. dateReturned still has to be checked client-side
    // (an open loan can have an old dateOut too), but that's now a filter
    // over a handful of already-old records instead of the whole history.
    const snap = await getDocs(
      query(collection(db, 'teachers', teacherUid, 'history'), where('dateOut', '<', cutoff)),
    );
    const stale = snap.docs.filter(d => !!d.data().dateReturned);
    for (const d of stale) {
      try { await deleteDoc(d.ref); deleted++; } catch (_) {}
    }
  } catch (err) {
    console.warn('[retention] history purge failed:', err);
  }
  return deleted;
}

// ── Purge: rosters of classes whose school year has ended ────────────────────

/** For every class past its last day of school, delete the student roster
 *  (name + email + join date) and stamp the class as archived. The class itself
 *  and the book library are kept — only the student personal data goes.
 *  Returns { classes, students } counts.
 *
 *  ── WHO CAN RUN THIS ────────────────────────────────────────────────────────
 *  Admins only, in practice. firestore.rules stops serving an expired roster to
 *  the owning TEACHER at the stroke of the last day, which is the whole point of
 *  the control — but it also means the teacher can no longer enumerate the
 *  roster in order to delete it. Admins keep read access precisely so somebody
 *  can still carry out the deletion.
 *
 *  So the two halves land like this:
 *    • access ends exactly on the last day, enforced server-side, for everyone
 *      except admins;
 *    • erasure happens the next time an admin opens the admin portal.
 *  Calling this as a teacher is harmless — the reads simply come back denied
 *  and it reports nothing purged. */
export async function purgeEndedClassRosters(db, teacherUid) {
  let classes = 0, students = 0;
  try {
    const snap = await getDocs(collection(db, 'teachers', teacherUid, 'classes'));

    // Students still enrolled in a class that HASN'T ended. Their flat-roster
    // membership marker must survive the purge below — that marker is what
    // firestore.rules checks to serve a Class Only library, so dropping it for
    // a student who is also in this teacher's second period would lock them out
    // of a class they are still in.
    const stillEnrolled = new Set();
    for (const c of snap.docs) {
      if (isClassExpired(c.data().endDate)) continue;
      try {
        const live = await getDocs(collection(db, 'teachers', teacherUid, 'classes', c.id, 'students'));
        live.docs.forEach(s => stillEnrolled.add(s.id));
      } catch (_) {}
    }

    for (const c of snap.docs) {
      const data = c.data();
      if (data.rosterPurgedAt) continue;          // already done
      if (!isClassExpired(data.endDate)) continue;

      const roster = await getDocs(
        collection(db, 'teachers', teacherUid, 'classes', c.id, 'students')
      );
      for (const s of roster.docs) {
        try {
          await deleteDoc(doc(db, 'teachers', teacherUid, 'classes', c.id, 'students', s.id));
          students++;
        } catch (_) {}
        // Revoke library access too. Deleting only the roster entry left the
        // student's flat membership marker behind, so the year would end, their
        // name would be erased, and they'd still be able to read and check out
        // this teacher's books forever.
        if (!stillEnrolled.has(s.id)) {
          try { await deleteDoc(doc(db, 'teachers', teacherUid, 'students', s.id)); } catch (_) {}
        }
      }
      try {
        await updateDoc(doc(db, 'teachers', teacherUid, 'classes', c.id), {
          rosterPurgedAt: serverTimestamp(),
          archived: true,
        });
        classes++;
      } catch (_) {}
    }
  } catch (err) {
    console.warn('[retention] roster purge failed:', err);
  }
  return { classes, students };
}

// ── Erasure: remove one student's personal data everywhere ───────────────────

/** Erase a single student's personal data from one teacher's tree: their entry
 *  in the flat legacy roster, their entry in every class roster, and the
 *  identifying fields on their checkout-history records.
 *
 *  History rows are REDACTED rather than deleted: the loan record itself is the
 *  library's own inventory record (which book went out and came back), while
 *  the student's name is the personal part. Redacting keeps the book trail
 *  intact without keeping the person attached to it. */
export async function eraseStudentFromTeacher(db, teacherUid, studentUid) {
  let rosterRemoved = 0, historyRedacted = 0;

  try { await deleteDoc(doc(db, 'teachers', teacherUid, 'students', studentUid)); rosterRemoved++; } catch (_) {}

  try {
    const classesSnap = await getDocs(collection(db, 'teachers', teacherUid, 'classes'));
    for (const c of classesSnap.docs) {
      try {
        await deleteDoc(doc(db, 'teachers', teacherUid, 'classes', c.id, 'students', studentUid));
        rosterRemoved++;
      } catch (_) {}
    }
  } catch (_) {}

  try {
    const hSnap = await getDocs(query(
      collection(db, 'teachers', teacherUid, 'history'),
      where('studentId', '==', studentUid)
    ));
    for (const h of hSnap.docs) {
      try {
        await updateDoc(h.ref, {
          studentId:   null,
          studentName: '[deleted]',
          redactedAt:  serverTimestamp(),
        });
        historyRedacted++;
      } catch (_) {}
    }
  } catch (_) {}

  return { rosterRemoved, historyRedacted };
}

/** Admin-side full erasure: walk every teacher and strip this student out.
 *  Used when an account is deleted, so "permanently delete" is actually true
 *  rather than leaving the student's name in every teacher's roster/history. */
export async function eraseStudentEverywhere(db, studentUid) {
  const totals = { teachers: 0, rosterRemoved: 0, historyRedacted: 0 };
  try {
    const teachersSnap = await getDocs(collection(db, 'teachers'));
    for (const t of teachersSnap.docs) {
      const r = await eraseStudentFromTeacher(db, t.id, studentUid);
      totals.teachers++;
      totals.rosterRemoved   += r.rosterRemoved;
      totals.historyRedacted += r.historyRedacted;
    }
  } catch (err) {
    console.warn('[retention] cross-teacher erasure failed:', err);
  }
  return totals;
}

// ── Opportunistic sweeps ─────────────────────────────────────────────────────

/** Teacher portal load. Purges this teacher's own expired checkout history, and
 *  attempts the roster purge (which only succeeds for classes that have not yet
 *  passed their cutoff — see purgeEndedClassRosters). Returns a summary for the
 *  UI, or null when nothing was purged. */
export async function runRetentionSweep(db, teacherUid) {
  const [history, rosters] = await Promise.all([
    purgeExpiredHistory(db, teacherUid),
    purgeEndedClassRosters(db, teacherUid),
  ]);
  if (!history && !rosters.classes && !rosters.students) return null;
  return { history, ...rosters };
}

/** Admin portal load. Sweeps EVERY teacher: expired rosters (which only an
 *  admin can still read) plus expired checkout history. This is the sweep that
 *  actually carries out end-of-year erasure, so the admin portal should be
 *  opened at least once after each school year ends.
 *
 *  Returns { classes, students, history } totals, or null if nothing was due. */
export async function runAdminRetentionSweep(db) {
  const totals = { classes: 0, students: 0, history: 0 };
  try {
    const teachersSnap = await getDocs(collection(db, 'teachers'));
    for (const t of teachersSnap.docs) {
      const r = await purgeEndedClassRosters(db, t.id);
      totals.classes  += r.classes;
      totals.students += r.students;
      totals.history  += await purgeExpiredHistory(db, t.id);
    }
  } catch (err) {
    console.warn('[retention] admin sweep failed:', err);
    return null;
  }
  if (!totals.classes && !totals.students && !totals.history) return null;
  return totals;
}

/** Classes whose roster is past its cutoff but still holds student records —
 *  i.e. erasure is overdue. Surfaced in the admin Debug panel so a stalled
 *  sweep is visible rather than silent. Admin-only (needs roster reads). */
export async function findOverdueRosters(db) {
  const overdue = [];
  try {
    const teachersSnap = await getDocs(collection(db, 'teachers'));
    for (const t of teachersSnap.docs) {
      const classesSnap = await getDocs(collection(db, 'teachers', t.id, 'classes'));
      for (const c of classesSnap.docs) {
        const data = c.data();
        if (!isClassExpired(data.endDate) || data.rosterPurgedAt) continue;
        const roster = await getDocs(collection(db, 'teachers', t.id, 'classes', c.id, 'students'));
        if (roster.size > 0) {
          overdue.push({
            teacher:   t.data().name ?? t.data().email ?? t.id,
            className: data.name ?? c.id,
            endDate:   endOfSchoolDay(data.endDate),
            students:  roster.size,
          });
        }
      }
    }
  } catch (err) {
    console.warn('[retention] overdue scan failed:', err);
  }
  return overdue;
}
