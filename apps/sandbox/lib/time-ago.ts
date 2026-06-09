import {
  differenceInDays,
  differenceInMilliseconds,
  differenceInMinutes,
  differenceInSeconds,
  isFuture,
  isThisYear,
  isToday,
  isTomorrow,
  isYesterday,
} from "date-fns"
import humanizeDuration from "humanize-duration"

const formatTime = (date: Date): string => {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

export const shortEnglishHumanizer = humanizeDuration.humanizer({
  language: "shortEn",
  languages: {
    shortEn: {
      y: () => "y",
      mo: () => "mo",
      w: () => "w",
      d: () => "d",
      h: () => "h",
      m: () => "min",
      s: () => "s",
      ms: () => "ms",
    },
  },
})

export const timeAgo = (date: Date, now = new Date()): string => {
  if (isFuture(date)) {
    if (differenceInSeconds(date, now) < 60) {
      return "in a few seconds"
    }

    if (differenceInMinutes(date, now) < 60) {
      return (
        "in " +
        shortEnglishHumanizer(differenceInMilliseconds(date, now), {
          round: true,
          units: ["m"],
        })
      )
    }

    if (isToday(date)) {
      return "Today at " + formatTime(date)
    }

    if (isTomorrow(date)) {
      return "Tomorrow at " + formatTime(date)
    }

    if (differenceInDays(date, now) < 6) {
      return date.toLocaleString("en-US", {
        weekday: "long",
        hour: "2-digit",
        minute: "2-digit",
      })
    }

    if (isThisYear(date)) {
      return date.toLocaleString("en-US", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    }

    return date.toLocaleString("en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
  }

  if (differenceInSeconds(now, date) < 60) {
    return "just now"
  }

  if (differenceInMinutes(now, date) < 60) {
    return (
      shortEnglishHumanizer(differenceInMilliseconds(now, date), {
        round: true,
        units: ["m"],
      }) + " ago"
    )
  }

  if (isToday(date)) {
    return formatTime(date)
  }

  if (isYesterday(date)) {
    return "Yesterday, " + formatTime(date)
  }

  if (differenceInDays(now, date) < 6) {
    return date.toLocaleString("en-US", {
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
    })
  }

  if (isThisYear(date)) {
    return date.toLocaleString("en-US", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
  }

  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

export const durationAgo = (date: Date, now = new Date()): string => {
  const duration = humanizeDuration(differenceInMilliseconds(now, date), {
    largest: 1,
    round: true,
  })
  return `${duration} ago`
}
