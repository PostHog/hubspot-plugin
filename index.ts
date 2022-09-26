const NEXT_CONTACT_BATCH_KEY = 'next_hubspot_contacts_url'
const SYNC_LAST_COMPLETED_DATE_KEY = 'last_job_complete_day'

const hubspotPropsMap = {
    companyName: 'company',
    company_name: 'company',
    company: 'company',
    lastName: 'lastname',
    last_name: 'lastname',
    lastname: 'lastname',
    firstName: 'firstname',
    first_name: 'firstname',
    firstname: 'firstname',
    phone_number: 'phone',
    phoneNumber: 'phone',
    phone: 'phone',
    website: 'website',
    domain: 'website',
    company_website: 'website',
    companyWebsite: 'website'
}

export const jobs = {
    'Clear storage': async (_, { storage }) => {
        await storage.del(NEXT_CONTACT_BATCH_KEY)
        await storage.del(SYNC_LAST_COMPLETED_DATE_KEY)
    }
}

export async function setupPlugin({ config, global }) {
    global.syncMode = config.syncMode
    global.hubspotAuth = `hapikey=${config.hubspotApiKey}`
    global.posthogUrl = config.postHogUrl

    global.syncScoresIntoPosthog = global.posthogUrl

    const authResponse = await fetchWithRetry(
        `https://api.hubapi.com/crm/v3/objects/contacts?limit=1&paginateAssociations=false&archived=false&${global.hubspotAuth}`
    )

    if (!statusOk(authResponse)) {
        throw new Error('Unable to connect to Hubspot. Please make sure your API key is correct.')
    }
}

export async function runEveryMinute({ global, storage }) {
    if (!global.syncScoresIntoPosthog) {
        console.log('Not syncing Hubspot Scores into PostHog - config not set.')
        return
    }

    const loadedContacts = await getHubspotContacts(global, storage)
    let skipped = 0
    let num_updated = 0
    let num_processed = 0
    let num_errors = 0
    for (const hubspotContact of loadedContacts) {
        const email = hubspotContact['email']
        const score = hubspotContact['score']

        if (email && score) {
            try {
                const updated = await updateHubspotScore(email, score, global)

                if (updated) {
                    num_updated += 1
                } else {
                    skipped += 1
                }
            } catch (error) {
                console.error(error.stack || error)
                console.log(`Error updating Hubspot score for ${email} - Skipping`)
                num_errors += 1
            }
        }

        num_processed += 1
    }

    console.log(
        `Successfully updated Hubspot scores for ${num_updated} records, skipped ${skipped} records, processed ${num_processed} Hubspot Contacts, errors: ${num_errors} `
    )

    const nextContactBatch = await storage.get(NEXT_CONTACT_BATCH_KEY)
    if (!nextContactBatch) {
        posthog.capture('hubspot contact sync all contacts completed', { num_updated: num_updated })

        const dateObj = new Date()
        await storage.set(
            SYNC_LAST_COMPLETED_DATE_KEY,
            `${dateObj.getUTCFullYear()}-${dateObj.getUTCMonth()}-${dateObj.getUTCDate()}`
        )
    } else {
        posthog.capture('hubspot contact sync batch completed', { num_updated: num_updated })
    }
}

async function getHubspotContacts(global, storage) {
    const properties = ['email', 'hubspotscore']

    let requestUrl = await storage.get(NEXT_CONTACT_BATCH_KEY)
    if (!requestUrl) {
        const lastFinishDate = await storage.get(SYNC_LAST_COMPLETED_DATE_KEY)
        const dateObj = new Date()
        const todayStr = `${dateObj.getUTCFullYear()}-${dateObj.getUTCMonth()}-${dateObj.getUTCDate()}`

        if (todayStr === lastFinishDate && global.syncMode === 'production') {
            console.log(`Not syncing contacts - sync already completed for ${todayStr}`)
            return []
        }

        // start fresh - begin processing all contacts
        requestUrl = `https://api.hubapi.com/crm/v3/objects/contacts?limit=100&paginateAssociations=false&archived=false&${
            global.hubspotAuth
        }&properties=${properties.join(',')}`
    }

    const loadedContacts = []
    const authResponse = await fetchWithRetry(requestUrl)
    const res = await authResponse.json()

    if (!statusOk(authResponse) || res.status === 'error') {
        const errorMessage = res.message ?? ''
        console.error(
            `Unable to get contacts from Hubspot. Status Code: ${authResponse.status}. Error message: ${errorMessage}`
        )
    }

    if (res && res['results']) {
        res['results'].forEach((hubspotContact) => {
            const props = hubspotContact['properties']
            loadedContacts.push({ email: props['email'], score: props['hubspotscore'] })
        })
    }

    let nextContactBatch
    res['paging'] && res['paging']['next']
        ? (nextContactBatch = res['paging']['next']['link'] + `&${global.hubspotAuth}`)
        : null

    await storage.set(NEXT_CONTACT_BATCH_KEY, nextContactBatch)
    console.log(`Loaded ${loadedContacts.length} Contacts from Hubspot`)
    return loadedContacts
}

async function updateHubspotScore(email: string, hubspotScore: string, global) {
    let updated = false

    const userRes = await posthog.api.get(`/api/projects/@current/persons?email=${email}`, {
        host: global.posthogUrl
    })
    const userResponse = await userRes.json()

    if (userResponse.results && userResponse.results.length > 0) {
        for (const loadedUser of userResponse['results']) {
            const userId = loadedUser['id']
            const distinct_id = loadedUser['distinct_ids'][0]

            if (userId) {
                console.log(`Updated Person ${email} with score ${hubspotScore}`)

                posthog.capture('hubspot score updated', {
                    distinct_id: distinct_id,
                    hubspot_score: hubspotScore,
                    $set: {
                        hubspot_score: parseInt(hubspotScore, 10)
                    }
                })

                updated = true
            }
        }
    }

    return updated
}

export async function onEvent(event, { config, global }) {
    const triggeringEvents = (config.triggeringEvents || '').split(',')

    if (triggeringEvents.indexOf(event.event) >= 0) {
        const email = getEmailFromEvent(event)

        if (email) {
            const emailDomainsToIgnore = (config.ignoredEmails || '').split(',')
            if (emailDomainsToIgnore.indexOf(email.split('@')[1]) >= 0) {
                return
            }
            await createHubspotContact(
                email,
                {
                    ...(event['$set'] ?? {}),
                    ...(event['properties'] ?? {})
                },
                global.hubspotAuth,
                config.additionalPropertyMappings,
                event['timestamp']
            )
        }
    }
}

async function createHubspotContact(email, properties, authQs, additionalPropertyMappings, eventSendTime) {
    let hubspotFilteredProps = {}
    for (const [key, val] of Object.entries(properties)) {
        if (hubspotPropsMap[key]) {
            hubspotFilteredProps[hubspotPropsMap[key]] = val
        }
    }

    if (additionalPropertyMappings) {
        for (let mapping of additionalPropertyMappings.split(',')) {
            const [postHogProperty, hubSpotProperty] = mapping.split(':')
            if (postHogProperty && hubSpotProperty) {
                // special case to convert an event's timestamp to the format Hubspot uses them
                if (postHogProperty === 'sent_at' || postHogProperty === 'created_at') {
                    const d = new Date(eventSendTime)
                    d.setUTCHours(0, 0, 0, 0)
                    hubspotFilteredProps[hubSpotProperty] = d.getTime()
                } else if (postHogProperty in properties) {
                    hubspotFilteredProps[hubSpotProperty] = properties[postHogProperty]
                }
            }
        }
    }

    const addContactResponse = await fetchWithRetry(
        `https://api.hubapi.com/crm/v3/objects/contacts?${authQs}`,
        {
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ properties: { email: email, ...hubspotFilteredProps } })
        },
        'POST'
    )

    const addContactResponseJson = await addContactResponse.json()

    if (!statusOk(addContactResponse) || addContactResponseJson.status === 'error') {
        const errorMessage = addContactResponseJson.message ?? ''
        console.log(
            `Unable to add contact ${email} to Hubspot. Status Code: ${addContactResponse.status}. Error message: ${errorMessage}`
        )

        if (addContactResponse.status === 409) {
            const existingIdRegex = /Existing ID: ([0-9]+)/
            const existingId = addContactResponseJson.message.match(existingIdRegex)
            console.log(`Attempting to update contact ${email} instead...`)

            const updateContactResponse = await fetchWithRetry(
                `https://api.hubapi.com/crm/v3/objects/contacts/${existingId[1]}?${authQs}`,
                {
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ properties: { email: email, ...hubspotFilteredProps } })
                },
                'PATCH'
            )

            const updateResponseJson = await updateContactResponse.json()
            if (!statusOk(updateContactResponse)) {
                const errorMessage = updateResponseJson.message ?? ''
                console.log(
                    `Unable to update contact ${email} to Hubspot. Status Code: ${updateContactResponse.status}. Error message: ${errorMessage}`
                )
            } else {
                console.log(`Successfully updated Hubspot Contact for ${email}`)
            }
        }
    } else {
        console.log(`Created Hubspot Contact for ${email}`)
    }
}

async function fetchWithRetry(url, options = {}, method = 'GET', isRetry = false) {
    try {
        const res = await fetch(url, { method: method, ...options })
        return res
    } catch {
        if (isRetry) {
            throw new Error(`${method} request to ${url} failed.`)
        }
        const res = await fetchWithRetry(url, options, (method = method), (isRetry = true))
        return res
    }
}

function statusOk(res) {
    return String(res.status)[0] === '2'
}

function isEmail(email) {
    const re = /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/
    return re.test(String(email).toLowerCase())
}

function getEmailFromEvent(event) {
    if (isEmail(event.distinct_id)) {
        return event.distinct_id
    } else if (event['$set'] && Object.keys(event['$set']).includes('email')) {
        if (isEmail(event['$set']['email'])) {
            return event['$set']['email']
        }
    } else if (event['properties'] && Object.keys(event['properties']).includes('email')) {
        if (isEmail(event['properties']['email'])) {
            return event['properties']['email']
        }
    }

    return null
}
