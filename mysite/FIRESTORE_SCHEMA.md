users/{uid} {
name: string
email: string
role: "student" | "teacher" | "admin"
banned: boolean
class: string | null
createdAt: timestamp
}

teachers/{teacherId} {
name: string
email: string
createdAt: timestamp
canInvite: boolean
}

teachers/{teacherId}/books/{bookId} {
title: string
author: string
isbn: string
coverUrl: string
description: string
status: "available" | "checked_out"
checkedOutBy: studentId | null
checkedOutAt: timestamp | null
wishlist: array<studentId>
}

teachers/{teacherId}/history/{entryId} {
bookId: string
bookTitle: string
studentId: string
studentName: string
dateOut: timestamp
dateReturned: timestamp | null
}

students/{studentId} {
name: string
email: string
currentBook: bookId | null
wishlist: array<bookId>
banned: boolean
}

invites/{token} {
createdBy: teacherId
createdAt: timestamp
expiresAt: timestamp
used: boolean
}

admin/settings {
maintenanceMode: boolean
globalBanList: array<uid>
}
