"use client"

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import {
  Bell, CalendarDays, CarFront, ChevronDown, Clock3, LayoutDashboard, MapPin,
  ParkingCircle, ShieldCheck, SlidersHorizontal, Users,
} from "lucide-react"
import { type BayVisualState } from "./parking-map"
import {
  createId, createInitialStore, DEMO_DATE, DEFAULT_ARRIVAL_WINDOW_MINUTES, formatTime, ROLE_LABELS,
  getArrivalDeadline, hasTimeOverlap, restoreDemoStore, STORAGE_KEY, TIME_PRESETS,
  toLocalDateTime, type Closure, type DemoStore, type DriverRole, type ParkingNotification,
  type ParkingSpace, type PermitCategory, type Reservation, type Role, type Vehicle, type Zone,
} from "./parking-data"
import {
  AdminOverview, BayDetails, ConfirmReservation, DemoControls, DriverSearch, ManageClosures,
  NotificationsScreen, OfficerOverview, PermitsAndRules, ReportsScreen,
  ReservationsScreen, RoleLanding, type MapListMode, type ScreenId, VehiclesScreen, ZonesAndSpaces,
} from "./parking-ui"

type NavEntry = { id: ScreenId; label: string; mobileLabel: string; detail: string; icon: ReactNode }
type Feedback = Record<string, { tone: "error" | "success"; text: string }>

const VEHICLE_RESERVATION_CONFLICT_MESSAGE = "This vehicle already has an overlapping reservation. Choose another vehicle or time."

function navigationFor(role: Role): NavEntry[] {
  if (role === "student" || role === "visitor") return [
    { id: "search", label: "Find parking", mobileLabel: "Find", detail: "Map & eligible bays", icon: <MapPin size={18} /> },
    { id: "reservations", label: "My reservations", mobileLabel: "Bookings", detail: "Check-in & departure", icon: <CalendarDays size={18} /> },
    { id: "vehicles", label: "Vehicles & permits", mobileLabel: "Vehicles", detail: "Driver profile", icon: <CarFront size={18} /> },
    { id: "notifications", label: "Notifications", mobileLabel: "Alerts", detail: "Booking updates", icon: <Bell size={18} /> },
  ]
  if (role === "officer") return [
    { id: "overview", label: "Occupancy overview", mobileLabel: "Overview", detail: "Map & bay directory", icon: <LayoutDashboard size={18} /> },
    { id: "closures", label: "Manage closures", mobileLabel: "Closures", detail: "Schedule a bay closure", icon: <Clock3 size={18} /> },
  ]
  return [
    { id: "overview", label: "Overview", mobileLabel: "Overview", detail: "Campus snapshot", icon: <LayoutDashboard size={18} /> },
    { id: "zones", label: "Zones & spaces", mobileLabel: "Spaces", detail: "Campus inventory", icon: <MapPin size={18} /> },
    { id: "permits", label: "Permits & rules", mobileLabel: "Permits", detail: "Eligibility settings", icon: <ShieldCheck size={18} /> },
    { id: "reports", label: "Reports", mobileLabel: "Reports", detail: "Usage & outcomes", icon: <CalendarDays size={18} /> },
  ]
}

function roleDefaultScreen(role: Role): ScreenId {
  return role === "student" || role === "visitor" ? "search" : "overview"
}

function roleCanOpen(role: Role, screen: ScreenId) {
  if (role === "student" || role === "visitor") return ["search", "confirm", "reservations", "vehicles", "notifications"].includes(screen)
  if (role === "officer") return ["overview", "bay-detail", "closures"].includes(screen)
  return ["overview", "zones", "permits", "reports"].includes(screen)
}

function parseScreen(hash: string): ScreenId | null {
  const screen = hash.replace(/^#\/?/, "")
  const allScreens: ScreenId[] = ["search", "confirm", "reservations", "vehicles", "notifications", "overview", "bay-detail", "closures", "zones", "permits", "reports"]
  return allScreens.includes(screen as ScreenId) ? screen as ScreenId : null
}

export function ParkingApp() {
  const [store, setStore] = useState<DemoStore>(() => createInitialStore())
  const [hydrated, setHydrated] = useState(false)
  const [screen, setScreen] = useState<ScreenId>("search")
  const [zoneId, setZoneId] = useState("north")
  const [date, setDate] = useState(DEMO_DATE)
  const [startTime, setStartTime] = useState("10:00")
  const [endTime, setEndTime] = useState("11:00")
  const [vehicleId, setVehicleId] = useState("vehicle-student")
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null)
  const [selectedBayId, setSelectedBayId] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<MapListMode>("map")
  const [officerZoneId, setOfficerZoneId] = useState("all")
  const [controlsOpen, setControlsOpen] = useState(false)
  const [searchAttempted, setSearchAttempted] = useState(false)
  const [confirmError, setConfirmError] = useState("")
  const [conflictMessage, setConflictMessage] = useState("")
  const [feedback, setFeedback] = useState<Feedback>({})

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY)
      const restored = saved ? restoreDemoStore(JSON.parse(saved)) : createInitialStore()
      setStore(restored)
      const requestedScreen = parseScreen(window.location.hash)
      if (window.location.hash.startsWith("#/")) {
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${requestedScreen ? `#${requestedScreen}` : ""}`)
      }
      if (requestedScreen && restored.activeRole && roleCanOpen(restored.activeRole, requestedScreen)) setScreen(requestedScreen)
      else if (restored.activeRole) setScreen(roleDefaultScreen(restored.activeRole))
      else if (requestedScreen) setScreen(requestedScreen)
    } catch {
      window.localStorage.removeItem(STORAGE_KEY)
      setStore(createInitialStore())
    }
    setHydrated(true)
  }, [])

  useEffect(() => {
    if (hydrated) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  }, [hydrated, store])

  useEffect(() => {
    if (!hydrated) return
    setStore((current) => {
      let changed = false
      const now = toLocalDateTime(DEMO_DATE, current.simulatedTime)
      const expired = current.reservations.filter((reservation) => reservation.status === "Reserved" && reservation.date === DEMO_DATE && now > getArrivalDeadline(reservation.date, reservation.startTime, current.arrivalWindowMinutes))
      if (!expired.length) return current
      changed = true
      const expiredIds = new Set(expired.map((reservation) => reservation.id))
      const notices = expired.filter((reservation) => !current.notifications.some((item) => item.kind === "system" && item.reservationId === reservation.id)).map((reservation): ParkingNotification => ({
        id: createId("notice"), ownerId: reservation.ownerId, kind: "system", title: "Reservation expired",
        message: `${reservation.reference} at ${reservation.spaceId} expired after its arrival window. The bay has been released.`,
        createdAt: `${DEMO_DATE}T${current.simulatedTime}:00`, read: false, reservationId: reservation.id,
      }))
      return { ...current, reservations: current.reservations.map((reservation) => expiredIds.has(reservation.id) ? { ...reservation, status: "Expired" } : reservation), notifications: [...notices, ...current.notifications] }
    })
  }, [hydrated, store.arrivalWindowMinutes, store.simulatedTime])

  useEffect(() => {
    if (!hydrated || !store.activeRole) return
    const onHashChange = () => {
      const requested = parseScreen(window.location.hash)
      if (requested && roleCanOpen(store.activeRole as Role, requested)) setScreen(requested)
      else if (requested) setScreen(roleDefaultScreen(store.activeRole as Role))
    }
    window.addEventListener("hashchange", onHashChange)
    return () => window.removeEventListener("hashchange", onHashChange)
  }, [hydrated, store.activeRole])

  useEffect(() => {
    if (hydrated && store.activeRole && roleCanOpen(store.activeRole, screen)) window.history.replaceState(null, "", `#${screen}`)
  }, [hydrated, screen, store.activeRole])

  const activeRole = store.activeRole
  const driverRole: DriverRole | null = activeRole === "student" || activeRole === "visitor" ? activeRole : null
  const driverVehicles = useMemo(() => store.vehicles.filter((vehicle) => driverRole && vehicle.ownerId === driverRole), [driverRole, store.vehicles])
  const activeVehicle = driverVehicles.find((vehicle) => vehicle.id === vehicleId) ?? driverVehicles[0]
  const currentReservations = driverRole ? store.reservations.filter((reservation) => reservation.ownerId === driverRole) : store.reservations
  const currentNotifications = driverRole ? store.notifications.filter((notification) => notification.ownerId === driverRole) : []
  const selectedSpace = store.spaces.find((space) => space.id === selectedSpaceId)
  const selectedBay = store.spaces.find((space) => space.id === selectedBayId)
  const now = toLocalDateTime(DEMO_DATE, store.simulatedTime)
  const validationError = useMemo(() => {
    if (!date) return "Choose a booking date."
    if (date < DEMO_DATE) return "Choose today or a future date."
    if (!startTime || !endTime) return "Choose both a start and end time."
    if (toLocalDateTime(date, endTime) <= toLocalDateTime(date, startTime)) return "The end time must be later than the start time."
    if (date === DEMO_DATE && toLocalDateTime(DEMO_DATE, store.simulatedTime) > getArrivalDeadline(date, startTime, store.arrivalWindowMinutes)) return "The arrival window for this start time has passed. Choose a later time."
    return ""
  }, [date, endTime, startTime, store.arrivalWindowMinutes, store.simulatedTime])

  const isEligible = useCallback((space: ParkingSpace, role: DriverRole, vehicle: Vehicle | undefined) => {
    const activePermit = store.permitCategories.some((permit) => permit.name === space.permit && permit.enabled)
    if (!activePermit || space.status !== "available") return false
    if (role === "visitor") return space.permit === "Visitor" && !!vehicle?.permits.includes("Visitor")
    return !!vehicle?.permits.includes(space.permit)
  }, [store.permitCategories])

  const overlaps = useCallback((spaceId: string, candidateDate: string, candidateStart: string, candidateEnd: string) => {
    const start = toLocalDateTime(candidateDate, candidateStart)
    const end = toLocalDateTime(candidateDate, candidateEnd)
    const closureConflict = store.closures.some((closure) => closure.spaceId === spaceId && closure.date === candidateDate && hasTimeOverlap(start, end, toLocalDateTime(closure.date, closure.startTime), toLocalDateTime(closure.date, closure.endTime)))
    const reservationConflict = store.reservations.some((reservation) => {
      if (reservation.spaceId !== spaceId || reservation.date !== candidateDate) return false
      if (reservation.status === "Checked In") return end > toLocalDateTime(reservation.date, reservation.startTime)
      return reservation.status === "Reserved" && hasTimeOverlap(start, end, toLocalDateTime(reservation.date, reservation.startTime), toLocalDateTime(reservation.date, reservation.endTime))
    })
    const externalConflict = store.externalBookings.some((booking) => booking.spaceId === spaceId && booking.date === candidateDate && hasTimeOverlap(start, end, toLocalDateTime(booking.date, booking.startTime), toLocalDateTime(booking.date, booking.endTime)))
    return closureConflict || reservationConflict || externalConflict
  }, [store.closures, store.externalBookings, store.reservations])

  const hasVehicleOverlap = useCallback((candidateVehicleId: string, candidateDate: string, candidateStart: string, candidateEnd: string) => {
    const start = toLocalDateTime(candidateDate, candidateStart)
    const end = toLocalDateTime(candidateDate, candidateEnd)
    return store.reservations.some((reservation) => {
      if (reservation.vehicleId !== candidateVehicleId || reservation.date !== candidateDate) return false
      if (reservation.status === "Checked In") return end > toLocalDateTime(reservation.date, reservation.startTime)
      return reservation.status === "Reserved" && hasTimeOverlap(start, end, toLocalDateTime(reservation.date, reservation.startTime), toLocalDateTime(reservation.date, reservation.endTime))
    })
  }, [store.reservations])
  const vehicleConflict = !!activeVehicle && !validationError && hasVehicleOverlap(activeVehicle.id, date, startTime, endTime)

  const searchSpaces = useMemo(() => {
    if (!driverRole || !activeVehicle || validationError || vehicleConflict) return []
    return store.spaces.filter((space) => space.zoneId === zoneId && isEligible(space, driverRole, activeVehicle) && !overlaps(space.id, date, startTime, endTime))
  }, [activeVehicle, date, driverRole, endTime, isEligible, overlaps, startTime, store.spaces, validationError, vehicleConflict, zoneId])


  const mapSpaces = useMemo(() => store.spaces.filter((space) => space.zoneId === zoneId), [store.spaces, zoneId])
  const driverMapStates = useMemo(() => Object.fromEntries(mapSpaces.map((space) => {
    if (selectedSpaceId === space.id && searchSpaces.some((item) => item.id === space.id)) return [space.id, "selected"]
    if (space.status === "occupied") return [space.id, "occupied"]
    if (!driverRole || !isEligible(space, driverRole, activeVehicle)) return [space.id, "restricted"]
    if (store.closures.some((closure) => closure.spaceId === space.id && closure.date === date && hasTimeOverlap(toLocalDateTime(date, startTime), toLocalDateTime(date, endTime), toLocalDateTime(date, closure.startTime), toLocalDateTime(date, closure.endTime)))) return [space.id, "closed"]
    if (overlaps(space.id, date, startTime, endTime) || vehicleConflict) return [space.id, "booked"]
    return [space.id, "available"]
  })) as Record<string, BayVisualState>, [activeVehicle, date, driverRole, endTime, isEligible, mapSpaces, overlaps, searchSpaces, selectedSpaceId, startTime, store.closures, vehicleConflict])

  const officerSpaces = useMemo(() => store.spaces.filter((space) => officerZoneId === "all" || space.zoneId === officerZoneId), [officerZoneId, store.spaces])
  const allOccupancyStates = useMemo(() => Object.fromEntries(store.spaces.map((space) => {
    const scheduledClosure = store.closures.some((closure) => closure.spaceId === space.id && closure.date === DEMO_DATE && now < toLocalDateTime(closure.date, closure.endTime))
    if (store.reservations.some((reservation) => reservation.spaceId === space.id && reservation.status === "Checked In")) return [space.id, "occupied"]
    if (scheduledClosure) return [space.id, "closed"]
    if (store.reservations.some((reservation) => reservation.spaceId === space.id && reservation.status === "Reserved")) return [space.id, "reserved"]
    if (space.status === "occupied") return [space.id, "occupied"]
    if (space.status === "restricted") return [space.id, "restricted"]
    return [space.id, "available"]
  })) as Record<string, BayVisualState>, [now, store.closures, store.reservations, store.spaces])
  const occupancyStates = allOccupancyStates
  const officerOccupancyStates = useMemo(() => Object.fromEntries(officerSpaces.map((space) => [space.id, allOccupancyStates[space.id]])) as Record<string, BayVisualState>, [allOccupancyStates, officerSpaces])

  function setDemoTime(time: string) {
    if (!TIME_PRESETS.includes(time)) return
    setStore((current) => ({ ...current, simulatedTime: time }))
    setFeedback({})
    setConflictMessage("")
  }

  function resetDemo() {
    setStore(createInitialStore())
    setZoneId("north")
    setDate(DEMO_DATE)
    setStartTime("10:00")
    setEndTime("11:00")
    setVehicleId("vehicle-student")
    setSelectedSpaceId(null)
    setSelectedBayId(null)
    setOfficerZoneId("all")
    setControlsOpen(false)
    setSearchAttempted(false)
    setConfirmError("")
    setConflictMessage("")
    setFeedback({})
    setScreen("search")
    window.history.replaceState(null, "", window.location.pathname)
    window.scrollTo(0, 0)
  }

  function chooseRole(role: Role) {
    const firstVehicle = store.vehicles.find((vehicle) => vehicle.ownerId === role)
    setStore((current) => ({ ...current, activeRole: role }))
    if (firstVehicle) setVehicleId(firstVehicle.id)
    setScreen(roleDefaultScreen(role))
    setSelectedSpaceId(null)
    setSelectedBayId(null)
    setConfirmError("")
    setFeedback({})
    window.scrollTo(0, 0)
  }

  function switchRole() {
    setStore((current) => ({ ...current, activeRole: null }))
    setScreen("search")
    setSelectedSpaceId(null)
    setSelectedBayId(null)
    setConfirmError("")
    window.scrollTo(0, 0)
  }

  function navigate(next: ScreenId) {
    if (!activeRole || !roleCanOpen(activeRole, next)) return
    setScreen(next)
    window.scrollTo(0, 0)
    if (next !== "confirm") setConfirmError("")
  }

  function runSearch() {
    setSearchAttempted(true)
    setSelectedSpaceId((current) => current && searchSpaces.some((space) => space.id === current) ? current : null)
  }

  function selectSearchSpace(space: ParkingSpace) {
    if (!searchSpaces.some((item) => item.id === space.id)) return
    setSelectedSpaceId(space.id)
    setConfirmError("")
  }

  function continueToConfirmation() {
    if (!selectedSpace || !searchSpaces.some((space) => space.id === selectedSpace.id) || validationError) return
    setConfirmError("")
    navigate("confirm")
  }

  function simulateConflict() {
    const candidate = selectedSpace && isEligible(selectedSpace, driverRole ?? "student", activeVehicle) ? selectedSpace : searchSpaces[0]
    if (!candidate) {
      setConflictMessage("Choose an eligible bay in Find Parking before simulating a conflict.")
      return
    }
    const duplicate = store.externalBookings.some((booking) => booking.spaceId === candidate.id && booking.date === date && booking.startTime === startTime && booking.endTime === endTime)
    if (duplicate) {
      setConflictMessage(`The demo driver already holds ${candidate.id} for this time.`)
      return
    }
    setStore((current) => ({ ...current, externalBookings: [...current.externalBookings, { id: createId("guest"), spaceId: candidate.id, date, startTime, endTime }] }))
    setSelectedSpaceId(candidate.id)
    setConfirmError(`Another driver has just reserved ${candidate.id}. Confirm now to see the final availability check catch the conflict.`)
    setConflictMessage(`${candidate.id} is now held by another demo driver.`)
    if (driverRole && screen !== "confirm") setScreen("confirm")
  }

  function confirmReservation() {
    if (!driverRole || !selectedSpace || !activeVehicle) return
    if (validationError) { setConfirmError(validationError); return }
    if (hasVehicleOverlap(activeVehicle.id, date, startTime, endTime)) {
      setConfirmError(VEHICLE_RESERVATION_CONFLICT_MESSAGE)
      return
    }
    const liveSpace = store.spaces.find((space) => space.id === selectedSpace.id)
    if (!liveSpace || !isEligible(liveSpace, driverRole, activeVehicle) || overlaps(liveSpace.id, date, startTime, endTime)) {
      setConfirmError(`${selectedSpace.id} is no longer available for this time. No reservation was saved. Return to updated results to choose another bay.`)
      return
    }
    const reservation: Reservation = {
      id: createId("reservation"),
      reference: `UD-2026-${String(38 + store.reservations.length).padStart(3, "0")}`,
      ownerId: driverRole,
      spaceId: liveSpace.id,
      vehicleId: activeVehicle.id,
      date,
      startTime,
      endTime,
      status: "Reserved",
      checkedInAt: null,
      createdAt: `${DEMO_DATE}T${store.simulatedTime}:00`,
    }
    const notice: ParkingNotification = { id: createId("notice"), ownerId: driverRole, kind: "booking", title: "Reservation confirmed", message: `${reservation.reference} is confirmed for ${liveSpace.id}, ${date} from ${startTime} to ${endTime}.`, createdAt: reservation.createdAt, read: false, reservationId: reservation.id }
    setStore((current) => ({ ...current, reservations: [reservation, ...current.reservations], notifications: [notice, ...current.notifications] }))
    setConfirmError("")
    setSelectedSpaceId(null)
    navigate("reservations")
  }

  function updateReservation(reservationId: string, update: Partial<Reservation>) {
    setStore((current) => ({ ...current, reservations: current.reservations.map((reservation) => reservation.id === reservationId ? { ...reservation, ...update } : reservation) }))
  }

  function cancelReservation(reservation: Reservation) {
    if (reservation.status !== "Reserved" || toLocalDateTime(reservation.date, reservation.startTime) <= now) return
    updateReservation(reservation.id, { status: "Cancelled" })
    const notice: ParkingNotification = { id: createId("notice"), ownerId: reservation.ownerId, kind: "cancellation", title: "Reservation cancelled", message: `${reservation.reference} at ${reservation.spaceId} was cancelled. The bay is available to other eligible drivers.`, createdAt: `${DEMO_DATE}T${store.simulatedTime}:00`, read: false, reservationId: reservation.id }
    setStore((current) => ({ ...current, notifications: [notice, ...current.notifications] }))
  }

  function checkIn(reservation: Reservation) {
    if (reservation.status !== "Reserved") return
    const bookingStart = toLocalDateTime(reservation.date, reservation.startTime)
    const deadline = getArrivalDeadline(reservation.date, reservation.startTime, store.arrivalWindowMinutes)
    if (now < bookingStart) {
      setFeedback((current) => ({ ...current, [reservation.id]: { tone: "error", text: `Too early to check in. Check-in opens at ${formatTime(reservation.startTime)}.` } }))
      return
    }
    if (now > deadline) {
      updateReservation(reservation.id, { status: "Expired" })
      setFeedback((current) => ({ ...current, [reservation.id]: { tone: "error", text: `Arrival deadline passed at ${formatTime(`${String(deadline.getHours()).padStart(2, "0")}:${String(deadline.getMinutes()).padStart(2, "0")}`)}. The reservation expired and the bay was released.` } }))
      return
    }
    updateReservation(reservation.id, { status: "Checked In", checkedInAt: `${DEMO_DATE}T${store.simulatedTime}:00` })
    setFeedback((current) => ({ ...current, [reservation.id]: { tone: "success", text: `Arrival recorded at ${formatTime(store.simulatedTime)}. ${reservation.spaceId} is now marked occupied.` } }))
  }

  function recordDeparture(reservation: Reservation) {
    if (reservation.status !== "Checked In") return
    updateReservation(reservation.id, { status: "Departed" })
    setFeedback((current) => ({ ...current, [reservation.id]: { tone: "success", text: `Departure recorded. ${reservation.spaceId} is available again when no other conflict applies.` } }))
  }

  function saveClosure(values: Omit<Closure, "id" | "createdAt">) {
    const closure: Closure = { ...values, id: createId("closure"), createdAt: `${DEMO_DATE}T${store.simulatedTime}:00` }
    const closureStart = toLocalDateTime(closure.date, closure.startTime)
    const closureEnd = toLocalDateTime(closure.date, closure.endTime)
    const impacted = store.reservations.filter((reservation) => reservation.spaceId === closure.spaceId && reservation.status === "Reserved" && toLocalDateTime(reservation.date, reservation.startTime) >= now && reservation.date === closure.date && hasTimeOverlap(closureStart, closureEnd, toLocalDateTime(reservation.date, reservation.startTime), toLocalDateTime(reservation.date, reservation.endTime)))
    const impactedIds = new Set(impacted.map((reservation) => reservation.id))
    const notices = impacted.flatMap((reservation): ParkingNotification[] => [
      { id: createId("notice"), ownerId: reservation.ownerId, kind: "cancellation", title: "Reservation cancelled", message: `${reservation.reference} at ${reservation.spaceId} was cancelled because the bay is closed for ${closure.reason}.`, createdAt: closure.createdAt, read: false, reservationId: reservation.id },
      { id: createId("notice"), ownerId: reservation.ownerId, kind: "closure", title: "Parking bay closure", message: `${closure.spaceId} is closed ${closure.date} from ${closure.startTime} to ${closure.endTime} for ${closure.reason}. Your overlapping booking was cancelled.`, createdAt: closure.createdAt, read: false, reservationId: reservation.id },
    ])
    setStore((current) => ({ ...current, closures: [closure, ...current.closures], reservations: current.reservations.map((reservation) => impactedIds.has(reservation.id) ? { ...reservation, status: "Cancelled" } : reservation), notifications: [...notices, ...current.notifications] }))
  }

  function removeClosure(closureId: string) {
    setStore((current) => ({ ...current, closures: current.closures.filter((closure) => closure.id !== closureId) }))
  }

  function saveVehicle(vehicle: Vehicle) {
    setStore((current) => ({ ...current, vehicles: current.vehicles.some((item) => item.id === vehicle.id) ? current.vehicles.map((item) => item.id === vehicle.id ? vehicle : item) : [...current.vehicles, vehicle] }))
  }

  function deleteVehicle(vehicleIdToDelete: string) {
    const inUse = store.reservations.some((reservation) => reservation.vehicleId === vehicleIdToDelete && ["Reserved", "Checked In"].includes(reservation.status))
    if (inUse) return
    setStore((current) => ({ ...current, vehicles: current.vehicles.filter((vehicle) => vehicle.id !== vehicleIdToDelete) }))
    if (vehicleId === vehicleIdToDelete) setVehicleId(driverVehicles.find((vehicle) => vehicle.id !== vehicleIdToDelete)?.id ?? "")
  }

  function markNotificationRead(notificationId: string) {
    setStore((current) => ({ ...current, notifications: current.notifications.map((notification) => notification.id === notificationId ? { ...notification, read: true } : notification) }))
  }

  function markAllNotificationsRead() {
    if (!driverRole) return
    setStore((current) => ({ ...current, notifications: current.notifications.map((notification) => notification.ownerId === driverRole ? { ...notification, read: true } : notification) }))
  }

  function setBayStatus(spaceId: string, status: ParkingSpace["status"]) {
    const activeSession = store.reservations.some((reservation) => reservation.spaceId === spaceId && reservation.status === "Checked In")
    if (activeSession) return
    setStore((current) => ({ ...current, spaces: current.spaces.map((space) => space.id === spaceId ? { ...space, status } : space) }))
  }

  function addZone(name: string) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "zone"
    let ordinal = store.zones.length + 1
    while (store.zones.some((zone) => zone.id === `${slug}-${String(ordinal).padStart(2, "0")}`)) ordinal += 1
    const id = `${slug}-${String(ordinal).padStart(2, "0")}`
    setStore((current) => ({ ...current, zones: [...current.zones, { id, name }] }))
    setOfficerZoneId("all")
  }

  function updateZone(zoneIdToUpdate: string, name: string) {
    if (!name.trim()) return
    setStore((current) => ({ ...current, zones: current.zones.map((zone) => zone.id === zoneIdToUpdate ? { ...zone, name } : zone) }))
  }

  function deleteZone(zoneIdToDelete: string) {
    if (store.spaces.some((space) => space.zoneId === zoneIdToDelete)) return
    setStore((current) => ({ ...current, zones: current.zones.filter((zone) => zone.id !== zoneIdToDelete) }))
  }

  function addSpace(zoneIdToAdd: string, permit: string) {
    const prefix = (store.zones.find((zone) => zone.id === zoneIdToAdd)?.name.split(/\s+/).map((word) => word[0]).join("").slice(0, 2) || "P").toUpperCase()
    const matching = store.spaces.filter((space) => space.id.startsWith(`${prefix}-`))
    const usedIds = new Set([...store.spaces.map((space) => space.id), ...store.reservations.map((reservation) => reservation.spaceId)])
    let ordinal = matching.reduce((max, space) => Math.max(max, Number(space.id.split("-").at(-1)) || 0), 0) + 1
    while (usedIds.has(`${prefix}-${String(ordinal).padStart(2, "0")}`)) ordinal += 1
    const id = `${prefix}-${String(ordinal).padStart(2, "0")}`
    setStore((current) => ({ ...current, spaces: [...current.spaces, { id, label: String(ordinal).padStart(2, "0"), zoneId: zoneIdToAdd, permit, status: "available" }] }))
  }

  function updateSpace(spaceId: string, values: Partial<Pick<ParkingSpace, "label" | "permit" | "zoneId">>) {
    setStore((current) => ({ ...current, spaces: current.spaces.map((space) => space.id === spaceId ? { ...space, ...values } : space) }))
  }

  function deleteSpace(spaceId: string) {
    setStore((current) => ({ ...current, spaces: current.spaces.filter((space) => space.id !== spaceId), closures: current.closures.filter((closure) => closure.spaceId !== spaceId) }))
  }

  function togglePermit(name: string) {
    setStore((current) => ({ ...current, permitCategories: current.permitCategories.map((permit) => permit.name === name ? { ...permit, enabled: !permit.enabled } : permit) }))
  }

  function addPermit(name: string) {
    if (store.permitCategories.some((permit) => permit.name.toLowerCase() === name.toLowerCase())) return
    setStore((current) => ({ ...current, permitCategories: [...current.permitCategories, { name, enabled: true }] }))
  }

  function removePermit(name: string) {
    if (store.spaces.some((space) => space.permit === name)) return
    setStore((current) => ({ ...current, permitCategories: current.permitCategories.filter((permit) => permit.name !== name), vehicles: current.vehicles.map((vehicle) => ({ ...vehicle, permits: vehicle.permits.filter((permit) => permit !== name) })) }))
  }

  function openNotificationBooking(reservation: Reservation) {
    if (reservation.ownerId !== driverRole) return
    setScreen("reservations")
    window.scrollTo(0, 0)
  }

  function openBay(space: ParkingSpace) {
    setSelectedBayId(space.id)
    setScreen("bay-detail")
    window.scrollTo(0, 0)
  }

  const navEntries = activeRole ? navigationFor(activeRole) : []
  const unreadCount = currentNotifications.filter((notification) => !notification.read).length
  const selectedBayStatus = selectedBay ? occupancyStates[selectedBay.id] ?? "available" : "available"
  const selectedBayZone = store.zones.find((zone) => zone.id === selectedBay?.zoneId)

  if (!hydrated) return <div className="parking-loading" aria-label="Loading Parksmart"><span className="brand-mark"><ParkingCircle size={23} /></span><span>Loading simulated campus data…</span></div>

  const controls = <DemoControls time={store.simulatedTime} arrivalWindowMinutes={store.arrivalWindowMinutes || DEFAULT_ARRIVAL_WINDOW_MINUTES} onSelectTime={setDemoTime} onReset={resetDemo} onSimulateConflict={simulateConflict} conflictMessage={conflictMessage} />
  if (!activeRole) return <RoleLanding spaces={store.spaces} zones={store.zones} reservations={store.reservations} closures={store.closures} simulatedTime={store.simulatedTime} onChoose={chooseRole} controls={controls} demoControlsOpen={controlsOpen} onToggleControls={() => setControlsOpen((open) => !open)} />

  const pageTitle = navEntries.find((item) => item.id === screen)?.label ?? (screen === "confirm" ? "Confirm reservation" : screen === "bay-detail" ? "Bay details" : screen)
  const profileTitle = activeRole === "student" ? "Sarah Ahmed" : activeRole === "visitor" ? "Demo visitor" : activeRole === "officer" ? "Campus operations" : "Parking administration"
  const profileSubtitle = activeRole === "student" ? "Student · 20241058" : activeRole === "visitor" ? "Visitor · seeded demo permit" : ROLE_LABELS[activeRole]
  const allZoneMapSpaces = officerSpaces
  const adminZoneOccupancy = store.zones.map((zone) => {
    const zoneSpaces = store.spaces.filter((space) => space.zoneId === zone.id)
    return { zone, total: zoneSpaces.length, occupied: zoneSpaces.filter((space) => occupancyStates[space.id] === "occupied").length, reserved: zoneSpaces.filter((space) => occupancyStates[space.id] === "reserved").length, closed: zoneSpaces.filter((space) => occupancyStates[space.id] === "closed").length }
  })

  return (
    <div className="parking-app">
      <aside className="app-sidebar">
        <button className="brand-lockup brand-button" type="button" onClick={() => navigate(roleDefaultScreen(activeRole))} aria-label="Parksmart home"><span className="brand-mark"><ParkingCircle size={23} /></span><span className="brand-copy"><strong>park<span>smart</span></strong><small>UNIVERSITY OF DUBAI</small></span></button>
        <div className="sidebar-section-label">{activeRole === "student" || activeRole === "visitor" ? "DRIVER SERVICES" : activeRole === "officer" ? "CAMPUS OPERATIONS" : "ADMINISTRATION"}</div>
        <nav className="primary-nav" aria-label="Main navigation">{navEntries.map((item) => <NavButton key={item.id} active={screen === item.id || (item.id === "overview" && screen === "bay-detail")} onClick={() => navigate(item.id)} icon={item.icon} label={item.label} mobileLabel={item.mobileLabel} detail={item.detail} count={item.id === "notifications" ? unreadCount : undefined} />)}</nav>
        <div className="sidebar-bottom"><div className="campus-status"><span className="live-dot" /><span><strong>Simulated campus data</strong><small>Shared across all demo roles</small></span></div><div className="profile-mini"><span className="avatar">{activeRole === "student" ? "SA" : activeRole === "visitor" ? "VD" : activeRole === "officer" ? "OP" : "AD"}</span><span><strong>{profileTitle}</strong><small>{profileSubtitle}</small></span><button className="switch-profile" type="button" onClick={switchRole} aria-label="Switch role"><ChevronDown size={15} /></button></div></div>
      </aside>
      <div className="app-main">
        <header className="topbar"><div className="mobile-brand"><span className="brand-mark"><ParkingCircle size={20} /></span><strong>park<span>smart</span></strong></div><div className="breadcrumb"><span>Campus mobility</span><span className="breadcrumb-slash">/</span><strong>{pageTitle}</strong></div><div className="topbar-actions"><span className="clock-chip" aria-label={`Simulated time ${formatTime(store.simulatedTime)}`}><span className="clock-chip-dot" /><Clock3 size={15} /><span>DEMO CLOCK <strong>{formatTime(store.simulatedTime)}</strong></span></span><button className={`controls-trigger ${controlsOpen ? "is-open" : ""}`} type="button" aria-expanded={controlsOpen} aria-controls="demo-controls" onClick={() => setControlsOpen((open) => !open)}><SlidersHorizontal size={16} /><span>Demo controls</span><ChevronDown size={14} /></button><button className="switch-role-button" type="button" onClick={switchRole}><Users size={15} /><span>Switch role</span></button></div></header>
        {controlsOpen && controls}
        <nav className="mobile-nav" aria-label="Parking pages">{navEntries.map((item) => <NavButton compact key={item.id} active={screen === item.id || (item.id === "overview" && screen === "bay-detail")} onClick={() => navigate(item.id)} icon={item.icon} label={item.label} mobileLabel={item.mobileLabel} count={item.id === "notifications" ? unreadCount : undefined} />)}</nav>
        <main className="page-content">
          {(screen === "search" && driverRole) && <DriverSearch role={driverRole} zoneId={zoneId} setZoneId={(value) => { setZoneId(value); setSelectedSpaceId(null) }} zones={store.zones} date={date} setDate={(value) => { setDate(value); setSelectedSpaceId(null) }} startTime={startTime} setStartTime={(value) => { setStartTime(value); setSelectedSpaceId(null) }} endTime={endTime} setEndTime={(value) => { setEndTime(value); setSelectedSpaceId(null) }} vehicles={driverVehicles} vehicleId={activeVehicle?.id ?? ""} setVehicleId={(value) => { setVehicleId(value); setSelectedSpaceId(null) }} zoneSpaces={mapSpaces} results={searchAttempted && validationError ? [] : searchSpaces} mapStates={driverMapStates} selectedSpaceId={selectedSpaceId} onSelectSpace={selectSearchSpace} onContinue={continueToConfirmation} mode={viewMode} setMode={setViewMode} error={searchAttempted ? validationError || (vehicleConflict ? VEHICLE_RESERVATION_CONFLICT_MESSAGE : "") : ""} onSearch={runSearch} />}
          {(screen === "confirm" && driverRole) && <ConfirmReservation space={selectedSpace} vehicle={activeVehicle} zoneName={store.zones.find((zone) => zone.id === selectedSpace?.zoneId)?.name ?? "Campus parking"} date={date} startTime={startTime} endTime={endTime} arrivalWindowMinutes={store.arrivalWindowMinutes} error={confirmError} onBack={() => { setScreen("search"); setConfirmError("") }} onConfirm={confirmReservation} onUpdatedResults={() => { setScreen("search"); setConfirmError(""); setSearchAttempted(true) }} />}
          {(screen === "reservations" && driverRole) && <ReservationsScreen reservations={currentReservations} spaces={store.spaces} zones={store.zones} vehicles={store.vehicles} simulatedTime={store.simulatedTime} arrivalWindowMinutes={store.arrivalWindowMinutes} onCancel={cancelReservation} onCheckIn={checkIn} onDepart={recordDeparture} feedback={feedback} onFindParking={() => navigate("search")} />}
          {(screen === "vehicles" && driverRole) && <VehiclesScreen vehicles={driverVehicles} permits={store.permitCategories} protectedVehicleIds={store.reservations.filter((reservation) => ["Reserved", "Checked In"].includes(reservation.status)).map((reservation) => reservation.vehicleId)} onSave={saveVehicle} onDelete={deleteVehicle} />}
          {(screen === "notifications" && driverRole) && <NotificationsScreen notifications={currentNotifications} reservations={currentReservations} onMarkRead={markNotificationRead} onOpenReservation={openNotificationBooking} onMarkAllRead={markAllNotificationsRead} />}
          {(screen === "overview" && activeRole === "officer") && <OfficerOverview zones={store.zones} selectedZone={officerZoneId} setSelectedZone={setOfficerZoneId} spaces={allZoneMapSpaces} states={officerOccupancyStates} reservations={store.reservations} closures={store.closures} onSelectSpace={openBay} />}
          {(screen === "bay-detail" && activeRole === "officer") && <BayDetails space={selectedBay} zone={selectedBayZone} state={selectedBayStatus} reservations={store.reservations} closures={store.closures} simulatedTime={store.simulatedTime} onBack={() => navigate("overview")} onSetOccupied={() => selectedBay && setBayStatus(selectedBay.id, "occupied")} onSetAvailable={() => selectedBay && setBayStatus(selectedBay.id, "available")} onManageClosures={() => navigate("closures")} />}
          {(screen === "closures" && activeRole === "officer") && <ManageClosures spaces={store.spaces} zones={store.zones} reservations={store.reservations} closures={store.closures} arrivalWindowMinutes={store.arrivalWindowMinutes} simulatedTime={store.simulatedTime} onSave={saveClosure} onRemove={removeClosure} />}
          {(screen === "overview" && activeRole === "admin") && <AdminOverview metrics={{ total: store.spaces.length, available: Object.values(occupancyStates).filter((state) => state === "available").length, reserved: Object.values(occupancyStates).filter((state) => state === "reserved").length, occupied: Object.values(occupancyStates).filter((state) => state === "occupied").length, closed: Object.values(occupancyStates).filter((state) => state === "closed").length, reservations: store.reservations.length, unread: store.notifications.filter((item) => !item.read).length, permitAssignments: store.vehicles.reduce((count, vehicle) => count + vehicle.permits.filter((permit) => store.permitCategories.some((category) => category.name === permit && category.enabled)).length, 0) }} zoneOccupancy={adminZoneOccupancy} onNavigate={navigate} />}
          {(screen === "zones" && activeRole === "admin") && <ZonesAndSpaces zones={store.zones} spaces={store.spaces} permits={store.permitCategories} protectedSpaceIds={store.reservations.filter((reservation) => ["Reserved", "Checked In"].includes(reservation.status)).map((reservation) => reservation.spaceId)} onAddZone={addZone} onRenameZone={updateZone} onDeleteZone={deleteZone} onAddSpace={addSpace} onUpdateSpace={updateSpace} onDeleteSpace={deleteSpace} />}
          {(screen === "permits" && activeRole === "admin") && <PermitsAndRules permits={store.permitCategories} arrivalWindowMinutes={store.arrivalWindowMinutes} onTogglePermit={togglePermit} onAddPermit={addPermit} onRemovePermit={removePermit} onSetArrivalWindow={(value) => setStore((current) => ({ ...current, arrivalWindowMinutes: value }))} spaces={store.spaces} />}
          {(screen === "reports" && activeRole === "admin") && <ReportsScreen reservations={store.reservations} zones={store.zones} spaces={store.spaces} />}
        </main>
        <footer className="app-footer"><span>Smart Campus Parking</span><span>UNIVERSITY OF DUBAI <i>·</i> PROTOTYPE WITH SIMULATED CAMPUS DATA</span></footer>
      </div>
    </div>
  )
}

function NavButton({ active, onClick, icon, label, mobileLabel, detail, count, compact }: { active: boolean; onClick: () => void; icon: ReactNode; label: string; mobileLabel?: string; detail?: string; count?: number; compact?: boolean }) {
  return <button type="button" className={`nav-item ${active ? "active" : ""} ${compact ? "nav-item-compact" : ""}`} onClick={onClick} aria-current={active ? "page" : undefined}><span className="nav-icon">{icon}</span><span className="nav-label"><span className="nav-label-full">{label}</span>{detail && <small>{detail}</small>}{compact && <span className="nav-label-mobile">{mobileLabel ?? label}</span>}</span>{typeof count === "number" && count > 0 && <span className="nav-count">{count}</span>}</button>
}
