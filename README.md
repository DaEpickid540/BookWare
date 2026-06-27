# BookWare

A Firebase-hosted school library management platform with three separate portals: Student, Teacher, and Admin. Students browse and check out books, teachers manage their library and class rosters, and admins handle platform-wide moderation.

## Features

**Students** can check out and return books, manage a wishlist (including Google Books search), track their reading history and download it as Markdown, set a "currently reading" status, see teacher recommendations, and get notifications when wishlisted books become available. Privacy controls let you hide your reading activity from classmates.

**Teachers** manage a full library — adding books by title, author, or ISBN, setting copy quantities, toggling library visibility (class-only vs. public), tracking checked-out books, running bi-weekly check-in reports, and banning/unbanning students. Each teacher can have multiple classes with separate invite codes.

**Admins** (two hardcoded emails) get a dashboard with live stats, a full user table with ban/unban/delete, maintenance mode, and a debug panel with Firestore stats.

## Tech Stack

- **Frontend:** Vanilla JS, HTML, CSS (no framework)
- **Backend:** Firebase Hosting + Firestore (no server)
- **Auth:** Firebase Google Sign-In
- **Book data:** Open Library API (primary), Google Books API (fallback)
- **AI:** Optional ARIA integration via Groq API (key stored in browser only)

## Project Structure

```
mysite/
├── public/
│   ├── index.html          Landing / login portal
│   ├── student.html        Student SPA
│   ├── teacher.html        Teacher SPA
│   ├── admin.html          Admin SPA
│   ├── teacher-signup.html Invite claim page
│   ├── css/                Design system (variables, base, components, responsive)
│   └── js/
│       ├── firebase.js     Firebase init
│       ├── auth.js         Login handler
│       ├── books.js        Book search (Open Library + Google Books)
│       ├── student.js      Student portal logic
│       ├── teacher.js      Teacher portal logic
│       ├── admin.js        Admin portal logic
│       └── teacher-signup.js  Invite claim flow
├── firestore.rules
└── firebase.json
```

## Setup

1. Create a Firebase project and enable Firestore + Google Auth
2. Update the Firebase config in `js/firebase.js` with your project credentials
3. Deploy: `firebase deploy`

Teachers must be invited via the invite link system — they cannot self-register. Admin access is restricted to the two emails hardcoded in `auth.js`.

## Theming

6 built-in presets (Midnight, Night, Dusk, Ash, Parchment, Snow) with a brightness slider and 6 accent color options. Settings are saved to Firestore per user.
