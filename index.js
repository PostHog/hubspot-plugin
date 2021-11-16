async function setupPlugin({ config, global }) {
    global.hubspotAuth = `hapikey=${config.hubspotApiKey}`

    const authResponse = await fetchWithRetry(
        `https://api.hubapi.com/crm/v3/objects/contacts?limit=1&paginateAssociations=false&archived=false&${global.hubspotAuth}`
    )

    if (!statusOk(authResponse)) {
        throw new Error('Unable to connect to Hubspot. Please make sure your API key is correct.')
    }
}

async function runEveryMinute({ config, global }) {
    await global.posthog.api.get('/api/event', {
        data: { param: 'some param' },
        host: 'https://posthog.mydomain.com'
    })

    console.log('IN RUN EVERY DAY..')
    const properties = ['email', 'hubspotscore']

    let requestUrl = `https://api.hubapi.com/crm/v3/objects/contacts?limit=100&paginateAssociations=false&archived=false&${
        global.hubspotAuth
    }&properties=${properties.join(',')}`
    let x = 0
    const loadedContacts = []
    while (requestUrl) {
        x += 1
        console.log(`Loop ${x} starting`)
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

        requestUrl =
            res['paging'] && res['paging']['next']
                ? (requestUrl = res['paging']['next']['link'] + `&${global.hubspotAuth}`)
                : null
    }

    loadedContacts.forEach((contact) => {
        const email = contact['email']
        const score = contact['score']
        global.posthog.api.patch()
    })

    console.log(JSON.stringify(loadedContacts, null, 2))
    console.log(loadedContacts.length)
    // const res = await authResponse.json()
    // console.log(JSON.stringify(res, null, 2))
}

async function onEvent(event, { config, global }) {
    console.log('IN ON EVENT')
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
                event['sent_at']
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
                if (postHogProperty === 'sent_at') {
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
