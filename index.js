async function setupPlugin({ config, global }) {
    global.hubspotAuth = `hapikey=${config.hubspotApiKey}`

    const authResponse = await fetchWithRetry(
        `https://api.hubapi.com/crm/v3/objects/contacts?limit=1&paginateAssociations=false&archived=false&${global.hubspotAuth}`
    )

    if (!statusOk(authResponse)) {
        throw new Error('Unable to connect to Hubspot. Please make sure your API key is correct.')
    }
}

async function onEvent(event, { config, global }) {
    if (event.event === config.triggeringEvent) {
        const email = getEmailFromEvent(event)
        if (email) {
            await createHubspotContact(
                email,
                {
                    ...(event['$set'] ?? {}),
                    ...(event['properties'] ?? {})
                },
                global.hubspotAuth,
                config.additionalPropertyMappings
            )
        }
    }
}

async function createHubspotContact(email, properties, authQs, additionalPropertyMappings) {
    let hubspotFilteredProps = {}
    for (const [key, val] of Object.entries(properties)) {
        if (hubspotPropsMap[key]) {
            hubspotFilteredProps[hubspotPropsMap[key]] = val
        }
    }

    if (additionalPropertyMappings) {
        for (let mapping of additionalPropertyMappings.split(',')) {
            let postHogProperty = mapping.split(':')[0]
            let hubSpotProperty = mapping.split(':')[1]
            if (postHogProperty in properties) {
                hubspotFilteredProps[hubSpotProperty] = properties[postHogProperty]
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
