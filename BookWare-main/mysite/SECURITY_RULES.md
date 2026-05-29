rules_version = '2';
service cloud.firestore {
match /databases/{database}/documents {

    // USERS
    match /users/{uid} {
      allow read: if request.auth != null;
      allow write: if request.auth.uid == uid; // users can edit themselves
    }

    // TEACHERS + THEIR LIBRARIES
    match /teachers/{teacherId} {
      allow read: if true;

      allow write: if request.auth != null
                   && request.auth.uid == teacherId;

      // Books subcollection
      match /books/{bookId} {
        allow read: if true;

        allow write: if request.auth != null
                     && request.auth.uid == teacherId;
      }

      // History subcollection
      match /history/{entryId} {
        allow read: if request.auth != null
                     && request.auth.uid == teacherId;

        allow write: if request.auth != null
                     && request.auth.uid == teacherId;
      }
    }

    // STUDENTS
    match /students/{studentId} {
      allow read: if request.auth != null;

      allow write: if request.auth != null
                   && request.auth.uid == studentId;
    }

    // INVITES
    match /invites/{token} {
      allow read: if true;
      allow write: if request.auth != null; // teachers/admin will refine later
    }

    // ADMIN
    match /admin/{document=**} {
      allow read, write: if request.auth != null
                         && request.auth.token.admin == true;
    }

}
}
